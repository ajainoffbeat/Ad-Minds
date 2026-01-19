import admin from "firebase-admin";
import OpenAI from "openai";
import express from 'express';
import cors from 'cors'
import { onRequest } from "firebase-functions/v2/https";
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Buffer } from 'node:buffer';
import 'dotenv/config';


admin.initializeApp();

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

function log(event, data = {}) {
  console.log(`[${event}]`, data);
}

const CONFIRMED_PROJECT_NUMBER = '361070828899'; 
const SECRET_NAME = `projects/${CONFIRMED_PROJECT_NUMBER}/secrets/OPENAI_API_KEY/versions/latest`;
const client = new SecretManagerServiceClient();
let cachedOpenaiApiKey = null;

// async function getOpenaiApiKey() {
//   if (cachedOpenaiApiKey) {
//     log("API_KEY_CACHED");
//     return cachedOpenaiApiKey;
//   }

//   log("API_KEY_FETCHING", { name: SECRET_NAME });
//   try {
//     const [version] = await client.accessSecretVersion({ name: SECRET_NAME });
    
//     const payload = version.payload.data.toString();
    
//     cachedOpenaiApiKey = payload;
//     log("API_KEY_FETCHED_SUCCESS");
//     return payload;
//   } catch(e) {
//     log("API_KEY_FETCH_FAILED", { error: e.message, stack: e.stack });
//     throw new Error(`Failed to access OpenAI API Key from Secret Manager: ${e.message}. Check that the secret exists at ${SECRET_NAME} and the function's service account has the 'Secret Manager Secret Accessor' role.`);
//   }
// }

async function getOpenaiApiKey() {
  // ✅ LOCAL EMULATOR → use .env
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY missing in .env");
    }
    log("API_KEY_FROM_ENV");
    return process.env.OPENAI_API_KEY;
  }

  // ✅ PRODUCTION → use Secret Manager
  if (cachedOpenaiApiKey) {
    log("API_KEY_CACHED");
    return cachedOpenaiApiKey;
  }

  log("API_KEY_FETCHING", { name: SECRET_NAME });
  const [version] = await client.accessSecretVersion({ name: SECRET_NAME });

  cachedOpenaiApiKey = version.payload.data.toString();
  log("API_KEY_FETCHED_SUCCESS");

  return cachedOpenaiApiKey;
}

const templates = {
    "KR": { 
        "thumbnail_style": "bright colors, bold Korean text",
        "video_style": "dynamic, energetic",
        "hashtags": ["#한국쇼츠", "#단기광고", "#AI마케팅"] 
    },
    "US": {
        "thumbnail_style": "clean bold text, strong contrast",
        "video_style": "fast-paced, cinematic",
        "hashtags": ["#Shorts", "#AIAds", "#MarketingTips"] 
    },
    "JP": { 
        "thumbnail_style": "minimal, soft tones, Japanese font",
        "video_style": "slow-motional, subtle transitions", 
        "hashtags": ["#日本ショート", "#AI広告", "#ビジネス"] 
        }
};

async function loadCountryTemplate() {
    const keys = Object.keys(templates);
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    const selectedTemplate = templates[randomKey];
    if (!selectedTemplate) {
      throw new Error("Template not found, internal logic error.");
    }
    return {randomKey, selectedTemplate};
}

async function generateAIScript(audience, brand, introduction, template, apiKey) {
  const prompt = `
The video must be completely generatable from text input.

Use the following details:
• Target Audience: ${audience}
• Brand Voice: ${brand}
• User Input Hook / Introduction: ${introduction}
• Video Style: ${template.video_style}
• Thumbnail Style: ${template.thumbnail_style}

STRICT REQUIREMENTS:

1. The script must be formatted as a **Scene-by-Scene Breakdown**:
   - Scene 1, Scene 2, Scene 3…
   - Each scene must include the following:
     • **Visual description** with exact camera angles, movements, objects, colors, lighting, and actions  
     • **Subtitle text** (short, punchy, 1–2 lines) — must appear clearly on screen  
     • **On-screen text overlay** (upper or lower third, visually branded)  
     • **Background music style** (genre + mood)  
     • **Transition instruction** into the next scene  

2. The script must be written so Sora-2 can generate:
   - Dynamic scene transitions  
   - Smooth camera motion and continuity  
   - Professional color grading  
   - A **consistent character / environment / visual theme** across all scenes  
   - A strong **brand presence** throughout (include brand colors, energy, tone, or branded objects where appropriate)

3. Additional Creative Requirements:
   - Begin with a **high-retention hook in the first 2 seconds**
   - End with a powerful, direct CTA tailored to the target audience
   - Integrate branding visually (e.g., branded colors, logo placement moments, branded props, or environment styling)
   - Ensure the subtitle system is used effectively in every scene:
     • Must be readable  
     • Must increase retention  
     • Must match the spoken or implied script  
   - Optimize for short-form **vertical video** pacing (fast, visually engaging, no long pauses)

4. OUTPUT FORMAT (MANDATORY):
Return only the following structure:

TITLE:
[Video Title based on user input]

SCENES:

Scene 1:
- Visuals:
- Subtitle:
- On-screen text:
- Music:
- Transition:

Scene 2:
- Visuals:
- Subtitle:
- On-screen text:
- Music:
- Transition:

(continue for all scenes needed for a 12-second short-form video)

FINAL CTA:
[Strong CTA related to audience + brand]

`;
    try {
        const openai = new OpenAI({ apiKey: apiKey });

        const script = await openai.responses.create({
            model: "gpt-5-mini",
            input: prompt
        });

        if (script.status === "completed") {
            return script.output_text;
        }

        return "failed";
    } catch (error) {
        log("AI Script Error:", error);
        throw new Error(`${error}`);
    }
}

async function downloadAndUploadContent(video, apiKey, userId) {
    try {
        const openai = new OpenAI({ apiKey: apiKey });

        log('Video generation completed: ', video);
        log('Downloading video content...');

        const content = await openai.videos.downloadContent(video.id);

        const body = content.arrayBuffer();
        const buffer = Buffer.from(await body);

        log('Wrote video.mp4');

        const storage = admin.storage().bucket();
        const videoUrl = `videos/${video.id}.mp4`;
        const uploadedFile = storage.file(videoUrl);

        await uploadedFile.save(buffer, {
            contentType: "video/mp4",
            public: true,
            metadata: {
                contentType: 'video/mp4',
                metadata: { userId: userId },
            }
        });

        const thumbnail = await openai.videos.downloadContent(video.id, {
          variant: "thumbnail"
        });

        const thumbBuffer = Buffer.from(await thumbnail.arrayBuffer());
        const thumbnailUrl = `thumnails/${video.id}.webp`;
        const uploadedThumnailFile = storage.file(thumbnailUrl);

        await uploadedThumnailFile.save(thumbBuffer, {
          contentType: "images/webp",
          public: true,
          metadata: {
            contentType: 'images/webp',
            metadata: {
                userId: userId,
            },
          }
        });

        const videoPublicUrl = uploadedFile.publicUrl();
        const thumnailPublicUrl = uploadedThumnailFile.publicUrl();

        return {
            videoUrl: videoPublicUrl,
            thumbnailUrl: thumnailPublicUrl
        };
    } catch (error) {
        log("AI Video Error:", error);
        throw new Error(`${error}`);
    }
}

async function generateVideo(script, apiKey) {
    try {
        const openai = new OpenAI({ apiKey: apiKey });

        let video = await openai.videos.create({
            model: 'sora-2',
            prompt: script,
            seconds: "12"
        });

        log('Video generation started: ', video);
        let progress = video.progress ?? 0;

        while (video.status === 'in_progress' || video.status === 'queued') {
            video = await openai.videos.retrieve(video.id);
            progress = video.progress ?? 0;

            const barLength = 30;
            const filledLength = Math.floor((progress / 100) * barLength);
            const bar = '='.repeat(filledLength) + '-'.repeat(barLength - filledLength);
            const statusText = video.status === 'queued' ? 'Queued' : 'Processing';
            log(bar);
            log(statusText);
            process.stdout.write(`${statusText}: [${bar}] ${progress.toFixed(1)}%`);

            await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        process.stdout.write('\n');

        if (video.status === 'failed') {
            console.error('Video generation failed');
            return "failed";
        }

        return video;
    } catch (error) {
        log("AI Video Error:", error);
        throw new Error(`${error}`);
    }
}

app.get('/generateScript', async (req, res) => {
    try {
        const {audience, brand, introduction, userId} = req.query;
        console.log("generateScript",audience, brand, introduction, userId);

        if (!audience || !brand || !introduction) {
          return res.status(400).json({
            error: "Missing required parameters: audience, brand, introduction",
          });
        }
        
        log(`brand ${brand}`);
        log(`audience ${audience}`);
        log(`introduction ${introduction}`);
        log(`userId ${userId}`);


        // await new Promise(resolve => setTimeout(resolve, 12000));
        // return res.status(200).json({success: true, videoDocument: 'Zk2fLX0frTzOMjTTu8IB',  script: "script", videoUrl: {"_firestore":{"projectId":"admind-adec4"},"_path":{"segments":["videos","Zk2fLX0frTzOMjTTu8IB"]},"_converter":{}}});
        
        const apiKey = await getOpenaiApiKey();

        const {randomKey: selectedCountry, selectedTemplate: template} = await loadCountryTemplate();

        log("SCRIPT_GENERATION_STARTED");
        const script = await generateAIScript(audience, brand, introduction, template, apiKey);
        log("SCRIPT_GENERATION_COMPLETED");

        // log(script);

        if(script != "failed") {
            const videoRef = await db.collection('videos').add({
                userId: db.doc(userId), 
                country: selectedCountry,
                template: { 
                    thumbnail_style: template.thumbnail_style,
                    video_style: template.video_style
                },
                script: script,
                hashtags: template.hashtags,
                audience: audience,
                brand: brand,
                introduction: introduction,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            await videoRef.update({
                videoRef: videoRef,
            });
            log("FIRESTORE_RECORD_SAVED", { videoId: videoRef.id });

            return res.status(200).json({success: true, videoDocument: videoRef.id, videoUrl: videoRef, script: script});
        } else {
            return res.status(500).json({error: "Failed to generate script"});
        }
    } catch (error) {
  log("REQUEST_FAILED", { error: error.message, stack: error.stack });
}
});

app.get('/generateVideo', async (req, res) => {
    try {
        const {userId, videoRef} = req.query;
        console.log(userId, videoRef);
        if (!userId || !videoRef) {
          return res.status(400).json({
            error: "Missing required parameters: script and video reference",
          });
        }
                
        log(`userId ${userId}`);
        log(`videoRef ${videoRef}`);
        
        // await new Promise(resolve => setTimeout(resolve, 12000));
        // return res.status(200).json({success: true, videoDocument: db.doc(videoRef).id, videoUrl: db.doc(videoRef)});
        
        const snap = await db.doc(videoRef).get();

        const script = snap.data().script;

        const apiKey = await getOpenaiApiKey();

        log("VIDEO_GENERATION_STARTED");
        const video = await generateVideo(script, apiKey); 
        log("VIDEO_GENERATION_COMPLETED");

        if(video != "failed") {
            log("VIDEO_SAVING_STARTED");
            const {videoUrl, thumbnailUrl} = await downloadAndUploadContent(video, apiKey, userId);
            log("VIDEO_SAVING_FINISHED", { videoUrl });
            
            const docRef = db.doc(videoRef);

            await docRef.update({
                script: script,
                videoUrl: videoUrl,
                thumbnailUrl: thumbnailUrl,
                ctr: 0,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            log("FIRESTORE_RECORD_SAVED", { videoId: docRef.id });

            return res.status(200).json({success: true, videoDocument: docRef.id, videoUrl: docRef});
        } else {
            return res.status(500).json({error: "Failed to generate video"});
        }
    } catch (err) {
        log("REQUEST_FAILED", { error: err.message, stack: err.stack });
        return res.status(500).json({ error: 'Internal server error during video generation.' });
    }
});

export const generateAdVideo = onRequest({ timeoutSeconds: 300 }, app);