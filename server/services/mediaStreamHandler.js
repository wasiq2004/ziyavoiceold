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

    // REPLACE the handleConnection method in mediaStreamHandler.js:

async handleConnection(ws, req) {
    let callId = null;
    let agentId = null;
    let session = null;
    
    try {
        console.log(`📞 WebSocket connection initiated from handleConnection`);
        
        // ✅ Set up error handler FIRST before any other operations
        ws.on("error", (error) => {
            // Ignore UTF-8 errors from binary frames (Twilio sends binary audio data)
            if (error.code === 'WS_ERR_INVALID_UTF8' || 
                error.message?.includes('invalid UTF-8') ||
                error.message?.includes('Invalid WebSocket frame')) {
                console.log("⚠️  Ignoring binary frame error (normal for audio data)");
                return; // Don't crash
            }
            console.error("❌ WebSocket error:", error);
        });

        ws.on("message", async (message) => {
            try {
                let data;
                
                // ✅ CRITICAL: Handle binary messages from Twilio
                if (Buffer.isBuffer(message)) {
                    // Binary message - try to parse as JSON first
                    try {
                        const messageStr = message.toString('utf8');
                        data = JSON.parse(messageStr);
                    } catch (e) {
                        // Not JSON - could be raw audio, ignore
                        return;
                    }
                } else if (typeof message === 'string') {
                    // String message - parse as JSON
                    data = JSON.parse(message);
                } else {
                    // Unknown message type
                    return;
                }

                // ✅ Get parameters from Twilio "start" event
                if (data.event === "start") {
                    console.log("▶️  Media Stream START event received");
                    
                    // Extract parameters from start event
                    const streamParams = data.start?.customParameters || {};
                    callId = streamParams.callId || data.start?.callSid;
                    agentId = streamParams.agentId;
                    const userId = streamParams.userId;
                    
                    console.log(`📞 Call ID: ${callId}`);
                    console.log(`🤖 Agent ID: ${agentId}`);
                    console.log(`👤 User ID: ${userId}`);

                    if (!callId) {
                        console.error("❌ No callId in start event");
                        ws.close();
                        return;
                    }

                    // Load agent configuration
                    let agentPrompt = "You are a helpful AI assistant.";
                    let agentVoiceId = "21m00Tcm4TlvDq8ikWAM"; // Default voice
                    let greetingMessage = "Hello! How can I help you today?";

                    if (agentId) {
                        try {
                            const AgentService = require('./agentService.js');
                            const agentService = new AgentService(require('../config/database.js').default);
                            
                            const agent = await agentService.getAgentById(userId, agentId);
                            if (agent) {
                                agentPrompt = agent.identity || agentPrompt;
                                
                                // ✅ CRITICAL: Use the voice ID directly from database
                                if (agent.voiceId) {
                                    agentVoiceId = agent.voiceId;
                                    console.log(`🎤 Using agent voice ID from database: ${agentVoiceId}`);
                                } else {
                                    console.warn(`⚠️  Agent has no voiceId, using default: ${agentVoiceId}`);
                                }
                                
                                if (agent.settings?.greetingLine) {
                                    greetingMessage = agent.settings.greetingLine;
                                }
                                console.log(`✅ Loaded agent: ${agent.name}`);
                                console.log(`   Voice ID: ${agentVoiceId}`);
                                console.log(`   Prompt: ${agentPrompt.substring(0, 100)}...`);
                            } else {
                                console.warn(`⚠️  Agent ${agentId} not found, using defaults`);
                            }
                        } catch (err) {
                            console.error("⚠️  Error loading agent:", err.message);
                        }
                    } else {
                        console.log(`ℹ️  No agentId provided, using default voice: ${agentVoiceId}`);
                    }

                    // Create session with the correct voice ID
                    session = this.createSession(callId, agentPrompt, agentVoiceId, ws);
                    console.log(`✅ Session created with voice ID: ${session.agentVoiceId}`);
                    
                    session.greetingMessage = greetingMessage;
                    session.streamSid = data.start.streamSid;
                    session.isReady = true;

                    // Initialize Deepgram
                    const deepgramLive = this.deepgramClient.listen.live({
                        encoding: "mulaw",
                        sample_rate: 8000,
                        model: "nova-2-phonecall",
                        smart_format: true,
                        interim_results: true,
                        utterance_end_ms: 1000,
                        punctuate: true,
                    });

                    session.sttStream = deepgramLive;

                    deepgramLive.on("Transcript", async (transcriptData) => {
                        try {
                            // Ignore interim results - only process final transcripts
                            if (!transcriptData.is_final) return;
                            
                            const transcript = transcriptData.channel?.alternatives?.[0]?.transcript;
                            if (!transcript?.trim()) return;

                            console.log(`🎤 "${transcript}"`);
                            this.appendToContext(session, transcript, "user");

                            const llmResponse = await this.callLLM(session);
                            this.appendToContext(session, llmResponse, "model");

                            console.log(`🔊 Synthesizing response with voice: ${session.agentVoiceId}`);
                            const ttsAudio = await this.synthesizeTTS(llmResponse, session.agentVoiceId);
                            if (ttsAudio) {
                                this.sendAudioToTwilio(session, ttsAudio);
                            }
                        } catch (err) {
                            console.error("❌ Transcript error:", err);
                        }
                    });

                    deepgramLive.on("Error", (error) => {
                        console.error("❌ Deepgram error:", error.message || "Unknown error");
                    });

                    deepgramLive.on("Open", () => {
                        console.log("✅ Deepgram opened");
                    });

                    deepgramLive.on("Close", () => {
                        console.log("⚠️ Deepgram connection closed");
                    });

                    // Send greeting after a short delay
                    setTimeout(async () => {
                        try {
                            console.log(`👋 Greeting: "${session.greetingMessage}"`);
                            console.log(`🔊 Using voice ID for greeting: ${session.agentVoiceId}`);
                            const audio = await this.synthesizeTTS(session.greetingMessage, session.agentVoiceId);
                            if (audio) {
                                this.sendAudioToTwilio(session, audio);
                            }
                        } catch (err) {
                            console.error("❌ Greeting error:", err);
                        }
                    }, 500);

                } else if (data.event === "connected") {
                    console.log("✅ Twilio connected");
                    
                } else if (data.event === "media") {
                    // ✅ Send audio directly to Deepgram
                    if (session?.sttStream && data.media?.payload) {
                        const audioBuffer = Buffer.from(data.media.payload, "base64");
                        if (audioBuffer.length > 0) {
                            session.sttStream.send(audioBuffer);
                        }
                    }
                    
                } else if (data.event === "stop") {
                    console.log("⏹️  Stream stopped");
                    if (callId) this.endSession(callId);
                    
                } else if (data.event === "mark") {
                    console.log("📍 Mark:", data.mark?.name);
                }
                
            } catch (err) {
                // Only log real errors
                if (!err.message?.includes('JSON') && !err.message?.includes('Unexpected')) {
                    console.error("❌ Message processing error:", err);
                }
            }
        });

        ws.on("close", () => {
            console.log("🔌 WebSocket closed");
            if (callId) this.endSession(callId);
        });

        console.log("✅ WebSocket handlers registered and ready");

    } catch (err) {
        console.error("❌ Connection setup error:", err);
        try {
            ws.close();
        } catch (closeErr) {
            // Ignore close errors
        }
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
        
        console.log(`🔊 Synthesizing TTS:`);
        console.log(`   Text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
        console.log(`   Voice ID: ${voiceId}`);
        console.log(`   API Key: ${apiKey.substring(0, 8)}...`);

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
        console.log(`✅ TTS generated: ${audioBuffer.length} bytes (µ-law 8kHz) using voice ${voiceId}`);
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
