/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';

// Initialize dotenv
dotenv.config();

const app = express();
const PORT = 3000;

// Set up large payload support for base64 images
app.use(express.json({ limit: '15mb' }));

// Initialize Gemini Client Lazily/Safely
let aiClient: GoogleGenAI | null = null;
const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

function getAiClient(requestApiKey?: string): GoogleGenAI {
  const apiKey = requestApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server. Please configure it in Settings > Secrets or supply a custom API key in the UI.');
  }
  
  if (requestApiKey) {
    // Return a fresh ephemeral client for this request's custom API key
    return new GoogleGenAI({
      apiKey: requestApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build-custom-key',
        },
      },
    });
  }

  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// 1. Health Endpoint
app.get('/api/health', (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const isConfigured = !!(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
  res.json({
    status: 'ok',
    isConfigured,
    model: modelName,
    message: isConfigured ? 'Gemini API is ready.' : 'GEMINI_API_KEY is missing or unconfigured.',
  });
});

// Helper for base64 parsing
function extractBase64(dataUrl: string): { data: string; mimeType: string } | null {
  if (!dataUrl) return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    // Check if it's just raw base64
    if (dataUrl.startsWith('eyJ') || dataUrl.length > 100) {
      return { mimeType: 'image/jpeg', data: dataUrl };
    }
    return null;
  }
  return { mimeType: match[1], data: match[2] };
}

// Defensive parsing helper
function parseDefensiveJson(text: string): any {
  const cleanText = text.trim();
  
  // Try direct parse
  try {
    return JSON.parse(cleanText);
  } catch (e) {
    // Continue
  }

  // Try fenced code block
  const fenceMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch (e) {
      // Continue
    }
  }

  // Extract first complete object between { and }
  const firstBrace = cleanText.indexOf('{');
  const lastBrace = cleanText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleanText.substring(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // Continue
    }
  }

  throw new Error(`Incomplete or unparseable JSON output from Gemini model. Output: "${text}"`);
}

// Validator
function validateResult(data: any): string | null {
  if (!data || typeof data !== 'object') {
    return 'Parsed result is not a valid JSON object';
  }

  const validEvents = ['tube_inserted', 'tourniquet_on', 'tourniquet_off', 'none'];
  if (!validEvents.includes(data.event)) {
    return `Invalid event value: "${data.event}"`;
  }

  const validColors = [
    'blood_culture',
    'light_blue',
    'red',
    'gold',
    'green',
    'lavender',
    'gray',
    'none',
  ];
  if (!validColors.includes(data.cap_color)) {
    return `Invalid cap_color value: "${data.cap_color}"`;
  }

  if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 1) {
    return `Invalid confidence value: ${data.confidence}`;
  }

  if (typeof data.tube_in_hand !== 'boolean' || typeof data.tube_seated_in_holder !== 'boolean') {
    return 'Evidence booleans (tube_in_hand, tube_seated_in_holder) must be boolean values';
  }

  // Check inconsistent evidence
  if (data.event === 'tube_inserted' && data.cap_color === 'none') {
    return "Inconsistent evidence: event is 'tube_inserted' but cap_color is 'none'";
  }
  if (data.event !== 'tube_inserted' && data.cap_color !== 'none') {
    return `Inconsistent evidence: event is '${data.event}' but cap_color is '${data.cap_color}'`;
  }

  return null;
}

const VISION_CLASSIFIER_PROMPT = `You are a strict visual state classifier for a clinical phlebotomy training video. You receive a CURRENT frame and may also receive the immediately preceding PREVIOUS frame.

Your job is to identify the blood collection tube that is physically engaged with the Vacutainer or needle holder in the CURRENT frame. Several unused tubes of different colors may be clearly visible on a nearby tray. Those are expected and must always be ignored.

Use the PREVIOUS frame only to distinguish the tube being moved by the operator from stationary tray tubes. Judge the returned state from the CURRENT frame. Return exactly one event:

- tube_inserted: The CURRENT frame clearly shows a tube being pushed into or already seated inside the Vacutainer or needle holder. The active tube must be physically aligned with and touching the holder. For a blood culture bottle, require visible connection to the collection tubing or adapter. Set tube_in_hand and tube_seated_in_holder to true and classify only this engaged tube’s cap.
- tourniquet_on: A tourniquet is clearly being applied or is visibly secured around an arm.
- tourniquet_off: A tourniquet is clearly being released or removed.
- none: None of the above is sufficiently clear.

Critical rules:

- Never classify a tube merely because its cap is large, colorful, or visible on the tray.
- A tube being picked up, held, shown to the camera, or moved toward the holder without visible contact is not inserted.
- Track the operator’s hand and the holder. Classify the cap belonging to that interaction, not the closest or most prominent cap elsewhere.
- If a tube is held but not seated, return event=none, cap_color=none, tube_in_hand=true, and tube_seated_in_holder=false.
- When no tube is actively held, both evidence booleans should be false.
- If holder contact, seating, or active cap color is ambiguous, return none rather than guessing.
- cap_color must be none unless event is tube_inserted.
- Confidence represents visual certainty from 0 to 1.
- Classify only. Do not judge protocol correctness and do not use the expected order to guess the tube color.`;

// 2. Detection Endpoint
app.post('/api/detect', async (req, res) => {
  const requestId = `detect-${Math.random().toString(36).substring(2, 11)}`;
  const startTime = Date.now();

  try {
    const { frame, previousFrame, timestamp, previousTimestamp, width, height } = req.body;
    const requestApiKey = req.headers['x-api-key'] as string | undefined;

    if (!frame) {
      return res.status(400).json({ error: 'Missing frame parameter' });
    }

    // 1. Get client or throw
    const ai = getAiClient(requestApiKey);

    // 2. Build parts
    const parts: any[] = [];
    parts.push({ text: VISION_CLASSIFIER_PROMPT });

    if (previousFrame) {
      const prevExtracted = extractBase64(previousFrame);
      if (prevExtracted) {
        parts.push({ text: 'PREVIOUS FRAME' });
        parts.push({
          inlineData: {
            mimeType: prevExtracted.mimeType,
            data: prevExtracted.data,
          },
        });
      }
    }

    const currExtracted = extractBase64(frame);
    if (!currExtracted) {
      return res.status(400).json({ error: 'Invalid frame format or encoding' });
    }

    parts.push({ text: 'CURRENT FRAME' });
    parts.push({
      inlineData: {
        mimeType: currExtracted.mimeType,
        data: currExtracted.data,
      },
    });

    console.info(`[${requestId}] Request initiated. Timestamps: Current=${timestamp}s, Prev=${previousTimestamp ?? 'none'}s. Dimensions: ${width ?? 'unknown'}x${height ?? 'unknown'}.`);

    // 3. Structured response configuration
    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        event: {
          type: Type.STRING,
          enum: ['tube_inserted', 'tourniquet_on', 'tourniquet_off', 'none'],
        },
        cap_color: {
          type: Type.STRING,
          enum: [
            'blood_culture',
            'light_blue',
            'red',
            'gold',
            'green',
            'lavender',
            'gray',
            'none',
          ],
        },
        tube_in_hand: {
          type: Type.BOOLEAN,
        },
        tube_seated_in_holder: {
          type: Type.BOOLEAN,
        },
        confidence: {
          type: Type.NUMBER,
        },
      },
      required: ['event', 'cap_color', 'tube_in_hand', 'tube_seated_in_holder', 'confidence'],
    };

    const response = await ai.models.generateContent({
      model: modelName,
      contents: parts,
      config: {
        responseMimeType: 'application/json',
        responseSchema,
        maxOutputTokens: 256,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
      },
    });

    const durationMs = Date.now() - startTime;
    const textOutput = response.text || '';
    const finishReason = response.candidates?.[0]?.finishReason || 'STOP';
    const usageMetadata = response.usageMetadata || {};

    // 4. Defensive Parsing
    let parsedResult: any;
    try {
      parsedResult = parseDefensiveJson(textOutput);
    } catch (parseErr: any) {
      console.error(`[${requestId}] Parser failed:`, parseErr.message);
      return res.status(502).json({
        error: 'JSON parsing failure from model response',
        details: parseErr.message,
        finishReason,
        _meta: {
          requestId,
          model: modelName,
          durationMs,
          finishReason,
          thinkingLevel: 'minimal',
        },
      });
    }

    // 5. Server-side Validation
    const validationError = validateResult(parsedResult);
    if (validationError) {
      console.warn(`[${requestId}] Validation warning:`, validationError);
      return res.status(422).json({
        error: 'Inference data validation failure',
        details: validationError,
        rawOutput: parsedResult,
        _meta: {
          requestId,
          model: modelName,
          durationMs,
          finishReason,
          thinkingLevel: 'minimal',
        },
      });
    }

    console.info(`[${requestId}] Success (${durationMs}ms): Event="${parsedResult.event}", Color="${parsedResult.cap_color}", Confidence=${parsedResult.confidence}.`);

    // 6. Return standard structured response
    res.json({
      event: parsedResult.event,
      cap_color: parsedResult.cap_color,
      tube_in_hand: parsedResult.tube_in_hand,
      tube_seated_in_holder: parsedResult.tube_seated_in_holder,
      confidence: parsedResult.confidence,
      _meta: {
        requestId,
        model: modelName,
        durationMs,
        finishReason,
        thinkingLevel: 'minimal',
        usageMetadata: {
          promptTokens: usageMetadata.promptTokenCount,
          candidatesTokens: usageMetadata.candidatesTokenCount,
          totalTokens: usageMetadata.totalTokenCount,
        },
      },
    });
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    console.error(`[${requestId}] Internal Server Error:`, err);
    
    const isQuotaExceeded = err.status === 429 || 
                            err.statusCode === 429 || 
                            (err.message && (err.message.includes('429') || err.message.includes('quota') || err.message.includes('RESOURCE_EXHAUSTED')));

    res.status(isQuotaExceeded ? 429 : 500).json({
      error: isQuotaExceeded ? 'Gemini API Quota Exceeded (429)' : 'Inference execution failed',
      details: err.message,
      _meta: {
        requestId,
        model: modelName,
        durationMs,
        finishReason: 'ERROR',
        thinkingLevel: 'minimal',
      },
    });
  }
});

// Vite Setup as Middleware / Static Server
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FlowVerify Backend] Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
