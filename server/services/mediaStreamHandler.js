const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { LLMService } = require("../llmService.js");
const nodeFetch = require("node-fetch");

const sessions = new Map();

class MediaStreamHandler {
    constructor(deepgramApiKey, geminiApiKey, campaignService) {
        if (!deepgramApiKey) throw new Error("Missing Deepgram API Key");
        if (!geminiApiKey) throw new Error("Missing Gemini API Key");

        this.deepgramClient = createClient(deepgramApiKey);
        this.llmService = new LLMService(geminiApiKey);
        this.campaignService = campaignService;
    }

    // ✅ FIX: Method to get fresh API key each time
    getElevenLabsApiKey() {
        return process.env.ELEVEN_LABS_API_KEY || process.env.ELEVENLABS_API_KEY;
    }

    createSession(callId, agentPrompt, agentVoiceId, ws) {
        const session = {
            callId,
            context: [],
            sttStream: null,
            agentPrompt,
            agentVoiceId: agentVoiceId || "21m00Tcm4TlvDq8ikWAM",
            ws,
            streamSid: null,
            isReady: false,
            audioQueue: [],
        };
        sessions.set(callId, session);
        console.log(`✅ Created session for call ${callId}`);
        console.log(`   Agent Prompt: ${agentPrompt.substring(0, 100)}...`);
        console.log(`   Voice ID: ${session.agentVoiceId}`);
        return session;
    }

    endSession(callId) {
        const session = sessions.get(callId);
        if (session) {
            if (session.sttStream) {
                session.sttStream.finish();
                session.sttStream.removeAllListeners();
            }
            sessions.delete(callId);
            console.log(`❌ Ended session for call ${callId}`);
        }
    }

    appendToContext(session, text, role) {
        session.context.push({ role, parts: [{ text }] });
        console.log(`💬 ${role.toUpperCase()}: ${text}`);
    }

    async handleConnection(ws, req) {
        let callId = null;
        try {
            // ✅ FIX: Parse query params correctly from Twilio
            const url = new URL(req.url, `http://${req.headers.host}`);
            const campaignId = url.searchParams.get('campaignId');
            const contactId = url.searchParams.get('contactId');
            const agentId = url.searchParams.get('agentId');
            const queryCallId = url.searchParams.get('callId');
            
            callId = queryCallId || contactId;

            if (!callId) {
                console.error("❌ Missing callId or contactId");
                ws.close();
                return;
            }

            console.log(`📞 New call connection: ${callId}`);
            console.log(`   Agent ID: ${agentId || 'none'}`);
            console.log(`   Campaign ID: ${campaignId || 'none'}`);
            console.log(`   Contact ID: ${contactId || 'none'}`);

            let agentPrompt = "You are a helpful AI assistant. Be concise and natural in your responses.";
            let agentVoiceId = "21m00Tcm4TlvDq8ikWAM";
            let greetingMessage = "Hello! How can I help you today?";

            if (agentId) {
                try {
                    const AgentService = require('./agentService.js');
                    const agentService = new AgentService(require('../config/database.js').default);
                    
                    const agent = await agentService.getAgentById('system', agentId);
                    if (agent) {
                        agentPrompt = agent.identity || agent.prompt || agentPrompt;
                        agentVoiceId = agent.voiceId || agentVoiceId;
                        if (agent.settings && agent.settings.greetingLine) {
                            greetingMessage = agent.settings.greetingLine;
                        }
                        console.log(`✅ Loaded agent: ${agent.name}`);
                        console.log(`   Voice ID: ${agentVoiceId}`);
                        console.log(`   Greeting: ${greetingMessage}`);
                    } else {
                        console.warn(`⚠️  Agent ${agentId} not found, using defaults`);
                    }
                } catch (agentError) {
                    console.error("Error loading agent:", agentError);
                }
            }

            const session = this.createSession(callId, agentPrompt, agentVoiceId, ws);
            session.greetingMessage = greetingMessage;

            // Initialize Deepgram STT stream
            const deepgramLive = this.deepgramClient.listen.live({
                encoding: "mulaw",
                sample_rate: 8000,
                model: "nova-2-phonecall",
                smart_format: true,
                interim_results: false,
                utterance_end_ms: 1000,
                punctuate: true,
            });

            session.sttStream = deepgramLive;

            deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
                try {
                    const transcript = data.channel?.alternatives?.[0]?.transcript;
                    if (!transcript || !transcript.trim()) return;

                    console.log(`🎤 Transcribed: "${transcript}"`);
                    this.appendToContext(session, transcript, "user");

                    const llmResponse = await this.callLLM(session);
                    this.appendToContext(session, llmResponse, "model");

                    const ttsAudio = await this.synthesizeTTS(llmResponse, session.agentVoiceId);
                    if (ttsAudio) {
                        this.sendAudioToTwilio(session, ttsAudio);
                    }
                } catch (err) {
                    console.error("❌ Error in transcript handler:", err);
                }
            });

            deepgramLive.on(LiveTranscriptionEvents.Error, (error) => {
                console.error("❌ Deepgram error:", error);
            });

            deepgramLive.on(LiveTranscriptionEvents.Close, () => {
                console.log("🔌 Deepgram connection closed");
            });

            deepgramLive.on(LiveTranscriptionEvents.Open, () => {
                console.log("✅ Deepgram connection opened");
            });

            ws.on("message", async (message) => {
                try {
                    const data = JSON.parse(message.toString());

                    if (data.event === "connected") {
                        console.log("✅ Twilio Media Stream connected");
                    } else if (data.event === "start") {
                        console.log("▶️  Media Stream started:", data.start.streamSid);
                        session.streamSid = data.start.streamSid;
                        session.isReady = true;

                        // Send queued audio
                        if (session.audioQueue.length > 0) {
                            console.log(`📤 Sending ${session.audioQueue.length} queued audio chunks`);
                            for (const audioBuffer of session.audioQueue) {
                                this.sendAudioToTwilio(session, audioBuffer);
                            }
                            session.audioQueue = [];
                        }

                        // Send greeting after connection is established
                        setTimeout(async () => {
                            console.log(`👋 Sending greeting: "${session.greetingMessage}"`);
                            const greetingAudio = await this.synthesizeTTS(
                                session.greetingMessage, 
                                session.agentVoiceId
                            );
                            if (greetingAudio) {
                                this.sendAudioToTwilio(session, greetingAudio);
                            }
                        }, 500);

                    } else if (data.event === "media") {
                        if (session.sttStream) {
                            const audioBuffer = Buffer.from(data.media.payload, "base64");
                            if (audioBuffer.length > 0) {
                                session.sttStream.send(audioBuffer);
                            }
                        }
                    } else if (data.event === "stop") {
                        console.log("⏹️  Media Stream stopped");
                        this.endSession(callId);
                    }
                } catch (err) {
                    console.error("❌ WS message error:", err);
                }
            });
            ws.on("close", () => {
                console.log("🔌 WebSocket closed");
                this.endSession(callId);
            });
            ws.on("error", (error) => {
                console.error("❌ WebSocket error:", error);
            });
        } catch (err) {
            console.error("❌ Error handling connection:", err);
            if (callId) {
                this.endSession(callId);
            }
            ws.close();
        }
    }
    async callLLM(session) {
        try {
            const response = await this.llmService.generateContent({
                model: "gemini-1.5-flash",
                contents: session.context,
                config: { systemInstruction: session.agentPrompt },
            });
            return response.text;
        } catch (err) {
            console.error("❌ LLM error:", err);
            return "I apologize, I'm having trouble processing that right now.";
        }
    }
    async synthesizeTTS(text, voiceId) {
        try {
            // ✅ FIX: Get fresh API key each time
            const apiKey = this.getElevenLabsApiKey();
            
            if (!apiKey) {
                console.error("❌ Missing ElevenLabs API key");
                return null;
            }
            console.log(`🔊 Synthesizing TTS with voice: ${voiceId}`);
            console.log(`🔑 Using API key: ${apiKey.substring(0, 8)}...`);

            const response = await nodeFetch(
                `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
                {
                    method: 'POST',
                    headers: {
                        'Accept': 'audio/basic',
                        'Content-Type': 'application/json',
                        'xi-api-key': apiKey,
                    },
                    body: JSON.stringify({
                        text: text,
                        model_id: 'eleven_turbo_v2_5',
                        voice_settings: {
                            stability: 0.5,
                            similarity_boost: 0.75,
                            style: 0.0,
                            use_speaker_boost: true
                        },
                        output_format: 'ulaw_8000'
                    })
                }
            );
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`❌ ElevenLabs API error: ${response.status} - ${errorText}`);
                return null;
            }
            const audioBuffer = await response.buffer();
            console.log(`✅ TTS generated: ${audioBuffer.length} bytes (µ-law 8kHz)`);
            return audioBuffer;
        } catch (err) {
            console.error("❌ TTS error:", err);
            return null;
        }
    }
    sendAudioToTwilio(session, audioBuffer) {
        try {
            if (!session.isReady || !session.streamSid) {
                console.log("⏸️  Queueing audio - stream not ready yet");
                session.audioQueue.push(audioBuffer);
                return;
            }
            const base64Audio = audioBuffer.toString("base64");
            const chunkSize = 214; // 160 bytes µ-law = 214 chars base64
            let chunksSent = 0;

            for (let i = 0; i < base64Audio.length; i += chunkSize) {
                const chunk = base64Audio.slice(i, i + chunkSize);
                session.ws.send(
                    JSON.stringify({
                        event: "media",
                        streamSid: session.streamSid,
                        media: { 
                            payload: chunk 
                        },
                    })
                );
                chunksSent++;
            }
            // Send mark to indicate audio completion
            session.ws.send(
                JSON.stringify({
                    event: "mark",
                    streamSid: session.streamSid,
                    mark: { name: "audio_complete" },
                })
            );
            console.log(`✅ Sent ${chunksSent} audio chunks to Twilio (streamSid: ${session.streamSid})`);
        } catch (err) {
            console.error("❌ Error sending audio to Twilio:", err);
        }
    }
}
module.exports = { MediaStreamHandler };
