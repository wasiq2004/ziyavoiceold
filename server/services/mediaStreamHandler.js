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
            
            // Real-time conversation state
            isAISpeaking: false,
            currentAudioChunks: [],
            userSpeechDetected: false,
            interimTranscript: "",
            silenceTimer: null,
            conversationBuffer: [],
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
            if (session.silenceTimer) {
                clearTimeout(session.silenceTimer);
            }
            sessions.delete(callId);
            console.log(`❌ Ended session for call ${callId}`);
        }
    }

    appendToContext(session, text, role) {
        session.context.push({ role, parts: [{ text }] });
        console.log(`💬 ${role.toUpperCase()}: ${text}`);
    }

    handleInterruption(session) {
        console.log("🛑 INTERRUPTING AI...");
        
        session.isAISpeaking = false;
        session.currentAudioChunks = [];
        
        try {
            session.ws.send(JSON.stringify({
                event: "clear",
                streamSid: session.streamSid
            }));
        } catch (err) {
            console.error("Error clearing audio:", err);
        }
        
        session.userSpeechDetected = true;
    }

    async handleUserMessage(session, userMessage) {
        try {
            const llmResponse = await this.callLLM(session);
            this.appendToContext(session, llmResponse, "model");
            await this.speakWithInterruption(session, llmResponse);
        } catch (err) {
            console.error("❌ Error handling message:", err);
        }
    }

    async speakWithInterruption(session, text) {
        console.log(`🔊 Speaking: "${text.substring(0, 50)}..."`);
        
        session.isAISpeaking = true;
        session.userSpeechDetected = false;

        const ttsAudio = await this.synthesizeTTS(text, session.agentVoiceId);
        
        if (!ttsAudio) {
            session.isAISpeaking = false;
            return;
        }

        session.currentAudioChunks.push(ttsAudio);

        if (session.userSpeechDetected) {
            console.log("⚠️  Interrupted before sending audio");
            session.isAISpeaking = false;
            return;
        }

        this.sendAudioToTwilio(session, ttsAudio);
    }

    async handleConnection(ws, req) {
        let callId = null;
        let agentId = null;
        let session = null;
        
        try {
            console.log(`📞 WebSocket connection initiated from handleConnection`);
            
            ws.on("error", (error) => {
                if (error.code === 'WS_ERR_INVALID_UTF8' || 
                    error.message?.includes('invalid UTF-8') ||
                    error.message?.includes('Invalid WebSocket frame')) {
                    console.log("⚠️  Ignoring binary frame error (normal for audio data)");
                    return;
                }
                console.error("❌ WebSocket error:", error);
            });

            ws.on("message", async (message) => {
                try {
                    let data;
                    
                    if (Buffer.isBuffer(message)) {
                        try {
                            const messageStr = message.toString('utf8');
                            data = JSON.parse(messageStr);
                        } catch (e) {
                            return;
                        }
                    } else if (typeof message === 'string') {
                        data = JSON.parse(message);
                    } else {
                        return;
                    }

                    if (data.event === "start") {
                        console.log("▶️  Media Stream START event received");
                        
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

                        let agentPrompt = "You are a helpful AI assistant.";
                        let agentVoiceId = "21m00Tcm4TlvDq8ikWAM";
                        let greetingMessage = "Hello! How can I help you today?";

                        if (agentId) {
                            try {
                                const AgentService = require('./agentService.js');
                                const agentService = new AgentService(require('../config/database.js').default);
                                
                                const agent = await agentService.getAgentById(userId, agentId);
                                if (agent) {
                                    agentPrompt = agent.identity || agentPrompt;
                                    
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

                        session = this.createSession(callId, agentPrompt, agentVoiceId, ws);
                        console.log(`✅ Session created with voice ID: ${session.agentVoiceId}`);
                        
                        session.greetingMessage = greetingMessage;
                        session.streamSid = data.start.streamSid;
                        session.isReady = true;

                        const deepgramLive = this.deepgramClient.listen.live({
                            encoding: "mulaw",
                            sample_rate: 8000,
                            model: "nova-2-phonecall",
                            smart_format: true,
                            interim_results: true,
                            utterance_end_ms: 800,
                            punctuate: true,
                            vad_events: true,
                        });

                        session.sttStream = deepgramLive;

                        deepgramLive.on("Transcript", async (transcriptData) => {
                            try {
                                const transcript = transcriptData.channel?.alternatives?.[0]?.transcript;
                                if (!transcript?.trim()) return;

                                if (!transcriptData.is_final) {
                                    session.interimTranscript = transcript;
                                    
                                    if (session.isAISpeaking && transcript.length > 3) {
                                        console.log(`🛑 USER INTERRUPTED: "${transcript}"`);
                                        this.handleInterruption(session);
                                    }
                                    return;
                                }

                                console.log(`🎤 FINAL: "${transcript}"`);
                                
                                if (session.silenceTimer) {
                                    clearTimeout(session.silenceTimer);
                                    session.silenceTimer = null;
                                }

                                this.appendToContext(session, transcript, "user");
                                await this.handleUserMessage(session, transcript);

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

                        setTimeout(async () => {
                            try {
                                console.log(`👋 Greeting: "${session.greetingMessage}"`);
                                console.log(`🔊 Using voice ID for greeting: ${session.agentVoiceId}`);
                                await this.speakWithInterruption(session, session.greetingMessage);
                            } catch (err) {
                                console.error("❌ Greeting error:", err);
                            }
                        }, 500);

                    } else if (data.event === "connected") {
                        console.log("✅ Twilio connected");
                        
                    } else if (data.event === "media") {
                        if (session?.sttStream && data.media?.payload) {
                            const audioBuffer = Buffer.from(data.media.payload, "base64");
                            if (audioBuffer.length > 0) {
                                session.sttStream.send(audioBuffer);
                                session.userSpeechDetected = true;
                            }
                        }
                        
                    } else if (data.event === "stop") {
                        console.log("⏹️  Stream stopped");
                        if (callId) this.endSession(callId);
                        
                    } else if (data.event === "mark") {
                        console.log("📍 Mark:", data.mark?.name);
                        
                        if (data.mark?.name === "audio_complete") {
                            if (session) {
                                session.isAISpeaking = false;
                                session.currentAudioChunks = [];
                                console.log("✅ AI finished speaking");
                            }
                        }
                    }
                    
                } catch (err) {
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
            const chunkSize = 214;
            let chunksSent = 0;

            for (let i = 0; i < base64Audio.length; i += chunkSize) {
                if (session.userSpeechDetected) {
                    console.log("⚠️  Stopped sending audio - user speaking");
                    session.isAISpeaking = false;
                    return;
                }

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
            session.isAISpeaking = false;
        }
    }
}

module.exports = { MediaStreamHandler };
