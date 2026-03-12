const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const DiagramBuilder = require("./diagramBuilder");
const diagramBuilder = new DiagramBuilder();

// === LLM Config ===
require("dotenv").config();
const LLM_CONFIG = {
  provider: process.env.LLM_PROVIDER || 'ollama', // 'ollama' or 'openai'
  modelNames: {
    fast: process.env.LLM_MODEL_FAST || 'deepseek-r1:1.5b',
    think: process.env.LLM_MODEL_THINK || 'deepseek-r1:1.5b',
    multimodal: process.env.LLM_MODEL_MULTIMODAL || 'deepseek-r1:1.5b',
    plan: process.env.LLM_MODEL_PLAN || 'deepseek-r1:1.5b',
  },
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434/api/chat',
  openaiUrl: process.env.OPENAI_URL || 'https://api.openai.com/v1/chat/completions',
};


const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 5001;
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
console.log(`[SERVER] Starting server with LLM Config: ${JSON.stringify(LLM_CONFIG)}`);
// In-memory session store
const sessions = {};

// === Context / Token Management Helpers ===
const MAX_BOARD_CHARS = parseInt(process.env.MAX_BOARD_CHARS || '6000', 10); // limit board JSON contribution
const MAX_CHAT_MESSAGES = parseInt(process.env.MAX_CHAT_MESSAGES || '10', 10); // tail chat messages to send
const MAX_USER_MESSAGE_CHARS = parseInt(process.env.MAX_USER_MESSAGE_CHARS || '4000', 10);

function slimElements(elements = []) {
  return elements.map(e => {
    const { id, type, text, x, y, width, height, start, end } = e;
    const base = { id, type };
    if (text) base.text = text.slice(0, 120);
    if (typeof x === 'number') base.x = Math.round(x);
    if (typeof y === 'number') base.y = Math.round(y);
    if (typeof width === 'number') base.width = Math.round(width);
    if (typeof height === 'number') base.height = Math.round(height);
    if (start && start.id) base.start = { id: start.id };
    if (end && end.id) base.end = { id: end.id };
    return base;
  });
}

function buildBoardContext(elements) {
  try {
    const slim = slimElements(elements || []);
    let json = JSON.stringify(slim);
    if (json.length > MAX_BOARD_CHARS) {
      json = json.slice(0, MAX_BOARD_CHARS) + '...';
    }
    return json;
  } catch (e) {
    return '[]';
  }
}

function tailChat(chatHistory = []) {
  if (chatHistory.length <= MAX_CHAT_MESSAGES) return chatHistory;
  const trimmed = chatHistory.slice(-MAX_CHAT_MESSAGES);
  return trimmed;
}

function approximateTokenLength(str='') { return Math.ceil(str.length / 4); }

function enforceMessageSize(message) {
  if (!message) return '';
  if (message.length <= MAX_USER_MESSAGE_CHARS) return message;
  return message.slice(0, MAX_USER_MESSAGE_CHARS) + '...';
}

// System prompts for each client
// Tool definitions for OpenAI function calling
const TOOLS = {
  classify_intent: {
    type: "function",
    function: {
      name: "classify_intent",
      description: "Classify the user's request to determine the appropriate action type",
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            description: "A short verb phrase describing what the user wants (e.g., 'draw diagram', 'modify diagram', 'analyze diagram', 'chat')"
          },
          type: {
            type: "string",
            enum: ["think", "multimodal", "chat"],
            description: "The type of model to use: 'think' for diagram creation/modification, 'multimodal' for image-based analysis, 'chat' for conversation"
          }
        },
        required: ["intent", "type"]
      }
    }
  },
  add_diagram_elements: {
    type: "function",
    function: {
      name: "add_diagram_elements",
      description: "Add new shapes or connections to the whiteboard diagram using Excalidraw element skeleton format",
      parameters: {
        type: "object",
        properties: {
          reply: {
            type: "string",
            description: "A concise natural-language message explaining what you added or why no action is needed"
          },
          elements: {
            type: "array",
            description: "Array of Excalidraw element skeletons to add. Shapes use 'label' for text. Arrows use 'start'/'end' with element IDs.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Descriptive unique ID (e.g. 'user-box', 'load-balancer')" },
                type: {
                  type: "string",
                  enum: ["rectangle", "ellipse", "diamond", "arrow", "line"],
                  description: "Element type"
                },
                x: { type: "number", description: "X coordinate (increases rightward)" },
                y: { type: "number", description: "Y coordinate (increases downward)" },
                width: { type: "number", description: "Width in pixels (shapes only, default 140)" },
                height: { type: "number", description: "Height in pixels (shapes only, default 60)" },
                label: {
                  type: "object",
                  description: "Text label for shapes (rectangle, ellipse, diamond)",
                  properties: {
                    text: { type: "string", description: "Label text" },
                    fontSize: { type: "number", description: "Font size (default 16)" }
                  },
                  required: ["text"]
                },
                start: {
                  type: "object",
                  properties: { id: { type: "string", description: "ID of the element this arrow starts from" } },
                  description: "Arrow start binding — reference an element by ID"
                },
                end: {
                  type: "object",
                  properties: { id: { type: "string", description: "ID of the element this arrow points to" } },
                  description: "Arrow end binding — reference an element by ID"
                }
              },
              required: ["type", "x", "y"]
            }
          }
        },
        required: ["reply", "elements"]
      }
    }
  },
  create_plan: {
    type: "function",
    function: {
      name: "create_plan",
      description: "Create a step-by-step plan for building a system diagram",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "Ordered list of short, actionable steps to build the diagram. Each step should describe a single component or connection.",
            items: {
              type: "string",
              description: "A single actionable step (e.g., 'Create a user box', 'Add load balancer', 'Connect user to load balancer')"
            }
          }
        },
        required: ["steps"]
      }
    }
  }
};

// System prompts for each client
const SYSTEM_PROMPTS = {
  fast: `You are a fast, lightweight AI assistant for the Brainstormer whiteboarding app. Your job is to classify the user's request to determine the appropriate action type. Use the classify_intent function to return your classification. Set type to "think" for diagram-related requests, "multimodal" only if the user explicitly mentions analyzing an image or diagram, and "chat" for general conversation.`,
  think: `You are an AI assistant helping users design diagrams on a collaborative whiteboard. Given the current board state and user request, add the appropriate shapes and connections.

Use the add_diagram_elements function to return your response. Use Excalidraw element skeleton format:
- Shapes: { "type": "rectangle", "id": "user-box", "x": 100, "y": 100, "width": 140, "height": 60, "label": { "text": "User" } }
- Arrows: { "type": "arrow", "id": "arrow-1", "x": 0, "y": 0, "start": { "id": "user-box" }, "end": { "id": "server-box" } }
- Use descriptive IDs (e.g. "user-box", "load-balancer", "db-1"). Never reuse IDs that exist on the board.
- Space shapes 200-250px apart horizontally. Start at x=100, y=150 unless the board already has elements.
- For arrows, x/y can be 0 — the positions are computed automatically from the bound elements.
- Only add elements relevant to the current step. If no diagram changes are needed, return an empty elements array.`,
  multimodal: `You are a multimodal AI assistant for a collaborative whiteboard. You receive a board summary and optionally a diagram image. Use the add_diagram_elements function to respond using Excalidraw element skeleton format: shapes use { type, id, x, y, width, height, label: { text } }, arrows use { type, id, x, y, start: { id }, end: { id } }. If the user wants analysis only, return an empty elements array.`,
  plan: `You are a planning agent. Given a high-level system design request, break it down into short, actionable steps. Use the create_plan function to return your plan. Each step should describe a single component or connection to draw (e.g., "Create a user box", "Add load balancer"). Do NOT repeat the user's prompt as a step. If you cannot break down the task, return a single generic step.`
};
function extractPlanSteps(planData, message) {
  let planSteps;
  try {
    // If planData is already an object with steps property (from tool call)
    if (typeof planData === 'object' && planData.steps && Array.isArray(planData.steps)) {
      planSteps = planData.steps;
    } else if (typeof planData === 'string') {
      // Handle plain text response by converting to single step
      const trimmed = planData.trim();
      
      // Try to parse as JSON first
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          planSteps = parsed;
        } else if (parsed.steps && Array.isArray(parsed.steps)) {
          planSteps = parsed.steps;
        } else if (typeof parsed === 'object') {
          const values = Object.values(parsed);
          if (values.length === 1 && (values[0] === message || values[0].toLowerCase().includes(message.toLowerCase()))) {
            planSteps = ["Break down the system into components and connections."];
          } else {
            planSteps = values;
          }
        }
      } catch (jsonErr) {
        // If JSON parsing fails, treat as plain text response
        console.log('[PLANNING] Plain text response detected, converting to single step');
        // Use the text as a single step if it's not the user's message
        if (trimmed !== message && !trimmed.toLowerCase().includes(message.toLowerCase())) {
          planSteps = [trimmed];
        } else {
          planSteps = ["Break down the system into components and connections."];
        }
      }
    } else if (Array.isArray(planData)) {
      planSteps = planData;
    }
    
    if (!planSteps || !Array.isArray(planSteps)) {
      planSteps = ["Break down the system into components and connections."];
    }
    
    // Only filter if steps actually contain the message (avoid false positives)
    planSteps = planSteps.filter(s => {
      if (typeof s !== 'string') return false;
      const stepLower = s.toLowerCase();
      const msgLower = message.toLowerCase();
      // Only filter if the step IS the message or contains it as the main part
      return s !== message && !stepLower.startsWith(msgLower);
    });
    
    if (planSteps.length === 0) planSteps = ["Break down the system into components and connections."];
  } catch (e) {
    console.error('[PLANNING] Error extracting plan steps:', e);
    planSteps = ["Break down the system into components and connections."];
  }
  return planSteps;
}
// LLM Client base class

class LLMClient {
  constructor(model, systemPrompt, tools = null) {
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.tools = tools;
  }
  buildPayload({ message, images = [] }) {
    return {
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: message, images },
      ],
      stream: false,
      options: { top_p: 0.4, temperature: 0.2 }
    };
  }
  async sendMessage({ message, images = [] }) {
    const payload = this.buildPayload({ message, images });
    let response;
    
    if (LLM_CONFIG.provider === 'ollama') {
      response = await axios.post(LLM_CONFIG.ollamaUrl, payload);
      return response.data.message.content;
    } else if (LLM_CONFIG.provider === 'openai') {
      // OpenAI Chat Completions API with tool calling
      const openaiPayload = {
        model: this.model,
        messages: [
          { role: "system", content: this.systemPrompt },
          { role: "user", content: message },
        ],
      };
      
      // Add tools if this client has them defined
      if (this.tools && this.tools.length > 0) {
        openaiPayload.tools = this.tools;
        openaiPayload.tool_choice = "required"; // Force model to use tools
        console.log(`[OpenAI] Sending request with ${this.tools.length} tool(s): ${this.tools.map(t => t.function.name).join(', ')}`);
      }
      
      try {
        response = await axios.post(
          LLM_CONFIG.openaiUrl,
          openaiPayload,
          {
            headers: {
              'Authorization': `Bearer ${LLM_CONFIG.openaiApiKey}`,
              'Content-Type': 'application/json'
            }
          }
        );
        
        // Handle OpenAI Chat Completions response
        if (response.data && response.data.choices && response.data.choices.length > 0) {
          const choice = response.data.choices[0];
          const message = choice.message;
          
          // Check if model used tool calling
          if (message.tool_calls && message.tool_calls.length > 0) {
            const toolCall = message.tool_calls[0];
            const functionArgs = JSON.parse(toolCall.function.arguments);
            console.log(`[OpenAI] Tool called: ${toolCall.function.name}`, functionArgs);
            return functionArgs;
          }
          
          // Fallback to regular content response
          if (message.content) {
            console.log(`[OpenAI] Received content response (no tool call):`, message.content.substring(0, 200));
            return message.content;
          }
        }
        
        console.error('[OpenAI API] Unexpected response:', JSON.stringify(response.data, null, 2));
        throw new Error('OpenAI API did not return expected response. See server logs for details.');
      } catch (err) {
        if (err.response) {
          console.error('[OpenAI API] Error response:', JSON.stringify(err.response.data, null, 2));
          throw new Error(`OpenAI API error: ${err.response.data.error?.message || 'Unknown error'}`);
        } else {
          console.error('[OpenAI API] Request error:', err);
          throw new Error('OpenAI API request failed. See server logs for details.');
        }
      }
    } else {
      throw new Error('Unknown LLM provider');
    }
  }
}

class FastLLMClient extends LLMClient {
  constructor() {
    super(
      LLM_CONFIG.modelNames.fast,
      SYSTEM_PROMPTS.fast,
      LLM_CONFIG.provider === 'openai' ? [TOOLS.classify_intent] : null
    );
  }
  buildPayload({ message }) {
    return {
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: message },
      ],
      stream: false,
      think: false,
      format: "json",
      options: { temperature: 0.2, top_p: 0.4 }
    };
  }
}

class ThinkingLLMClient extends LLMClient {
  constructor() {
    // Pass add_diagram_elements tool so OpenAI uses structured tool calling
    super(
      LLM_CONFIG.modelNames.think,
      SYSTEM_PROMPTS.think,
      LLM_CONFIG.provider === 'openai' ? [TOOLS.add_diagram_elements] : null
    );
  }
  buildPayload({ message }) {
    return {
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: message },
      ],
      stream: false,
      think: true,
      format: "json",
      options: { temperature: 0.4, top_p: 0.4 }
    };
  }
}

class MultiModalLLMClient extends LLMClient {
  constructor() {
    super(
      LLM_CONFIG.modelNames.multimodal,
      SYSTEM_PROMPTS.multimodal,
      LLM_CONFIG.provider === 'openai' ? [TOOLS.add_diagram_elements] : null
    );
  }
  buildPayload({ message, images = [] }) {
    const payload = {
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: message, images },
      ],
      stream: false,
      options: { temperature: 0.2, top_p: 0.4 }
    };
    
    return payload;
  }
}

// Factory for LLM clients
class PlanningLLMClient extends LLMClient {
  constructor() {
    super(
      LLM_CONFIG.modelNames.plan,
      SYSTEM_PROMPTS.plan,
      LLM_CONFIG.provider === 'openai' ? [TOOLS.create_plan] : null
    );
  }
  buildPayload({ message }) {
    const payload = {
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: message }
      ],
      stream: false,
      options: { temperature: 0.3, top_p: 0.4 }
    };
    
    // Add Ollama-specific parameters
    if (LLM_CONFIG.provider === 'ollama') {
      payload.format = "json";
    }
    
    return payload;
  }
}

class LLMClientFactory {
  static getClient(type) {
    switch (type) {
      case "fast": return new FastLLMClient();
      case "think": return new ThinkingLLMClient();
      case "multimodal": return new MultiModalLLMClient();
      case "plan": return new PlanningLLMClient();
      default: throw new Error("Unknown LLM client type");
    }
  }
}

function forceParseLLMJSON(input) {
  try {
    if (typeof input === "object") return input;
    let str = String(input).trim();
    
    // Check if it's a function call format like add_diagram_elements([...])
    const funcMatch = str.match(/add_diagram_elements\s*\(\s*(\[[\s\S]*\])\s*\)/);
    if (funcMatch) {
      console.log('[PARSE] Detected function call format, extracting JSON array');
      try {
        const elementsArray = JSON.parse(funcMatch[1]);
        return { reply: "Added diagram elements", elements: elementsArray };
      } catch (funcErr) {
        console.warn('[PARSE] Failed to parse function call arguments:', funcErr);
      }
    }
    
    // Check if it's a plain JSON array (starting with [)
    if (str.startsWith('[')) {
      console.log('[PARSE] Detected JSON array format');
      try {
        const elementsArray = JSON.parse(str);
        return { reply: "Added diagram elements", elements: elementsArray };
      } catch (arrErr) {
        console.warn('[PARSE] Failed to parse JSON array:', arrErr);
      }
    }
    
    // Remove leading/trailing braces and newlines
    str = str.replace(/^[\s{]+/, '{').replace(/[\s}]+$/, '}');
    // Try to extract the first JSON object in the string
    const match = str.match(/\{[\s\S]*\}/);
    if (match) str = match[0];
    let parsed = str;
    // Unwrap multiple layers of JSON strings
    while (typeof parsed === "string" && parsed.trim().startsWith("{")) {
      parsed = JSON.parse(parsed);
    }
    return parsed;
  } catch (e) {
    console.warn("Failed to fully parse LLM JSON:", input);
    return { reply: input, elements: [] };
  }
}

// Setup multer for handling file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Routing logic
// Routing logic
app.post("/api/chat", upload.single("image"), async (req, res) => {
  const { message } = req.body;
  const imageBuffer = req.file ? req.file.buffer : null;
  const base64Image = imageBuffer ? imageBuffer.toString("base64") : null;

  try {
    // Step 1: Use fast model to analyze intent
    const fastClient = LLMClientFactory.getClient("fast");
    const intentResponse = await fastClient.sendMessage({ message });
    let intent;
    
    // Handle both tool-based (OpenAI) and JSON-based (Ollama) responses
    if (typeof intentResponse === 'object' && intentResponse.intent && intentResponse.type) {
      // Tool call response from OpenAI
      intent = intentResponse;
    } else {
      // JSON string response from Ollama
      try {
        intent = JSON.parse(intentResponse);
      } catch (e) {
        console.error("Raw fast model response:", intentResponse);
        throw new Error("Failed to parse intent response from fast model");
      }
    }

    console.log(`[ROUTING] Intent classified as: ${intent.intent} -> ${intent.type}`);

    // Step 2: Route to appropriate model (never display fast model output)
    let clientType = intent.type;
    let client;
    // if (clientType === "multimodal" && base64Image) {
    //   client = LLMClientFactory.getClient("multimodal");
    // } else {
      // Default to thinking client for all other cases
    client = LLMClientFactory.getClient("think");
    //}

    // Step 3: Get response from routed client (only display output from thinking or multimodal client)
    const reply = await client.sendMessage({ message, images: base64Image ? [base64Image] : [] });
    res.json({ reply });
  } catch (error) {
    console.error("Error in LLM routing:", error);
    res.status(500).json({ error: error.message || "Error fetching data from LLM" });
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

// Parse elements from an LLM response (tool call or JSON string)
function extractElements(raw) {
  if (!raw) return { reply: '', elements: [] };
  if (typeof raw === 'object' && raw.elements !== undefined) return raw;
  const parsed = forceParseLLMJSON(raw);
  return { reply: parsed.reply || '', elements: parsed.elements || [] };
}

// Build the context string sent to the diagram model
function buildDiagramContext({ message, summary, chatHistory, stepDesc }) {
  const historyText = tailChat(chatHistory || [])
    .map(h => `${h.sender}: ${enforceMessageSize(h.text)}`)
    .join('\n');
  const boardCtx = summary ? `\nCurrent board: ${summary}` : '';
  const step = stepDesc ? `\nCurrent step: ${stepDesc}` : '';
  return `${enforceMessageSize(message)}${boardCtx}${step}\nRecent chat:\n${historyText}`;
}

// ─── Socket.io connection handler ───────────────────────────────────────────
io.on("connection", (socket) => {
  const sessionId = socket.id;
  console.log(`[SOCKET] Client connected: ${sessionId}`);
  sessions[sessionId] = { chatHistory: [], summary: "" };

  // ── Single unified message handler ──────────────────────────────────────
  socket.on("message", async (payload) => {
    const { message, elements, summary, chatHistory } = payload;
    const session = sessions[sessionId];
    session.chatHistory = chatHistory || [];
    session.summary = summary || '';

    console.log(`[SOCKET] message from ${sessionId}: "${message.slice(0, 80)}"`);

    try {
      // ── 1. Classify intent ──────────────────────────────────────────────
      const fastClient = LLMClientFactory.getClient("fast");
      const intentRaw = await fastClient.sendMessage({ message });
      let intent;
      if (typeof intentRaw === 'object' && intentRaw.type) {
        intent = intentRaw;
      } else {
        try { intent = JSON.parse(intentRaw); } catch (_) {
          intent = { type: 'think', intent: 'draw diagram' };
        }
      }
      console.log(`[ROUTING] intent: ${intent.intent} → ${intent.type}`);

      // ── 2a. Pure chat ────────────────────────────────────────────────────
      if (intent.type === 'chat') {
        const thinkClient = LLMClientFactory.getClient("think");
        const ctx = buildDiagramContext({ message, summary: session.summary, chatHistory: session.chatHistory });
        const raw = await thinkClient.sendMessage({ message: ctx });
        const { reply } = extractElements(raw);
        socket.emit("reply", { type: "chat", reply: reply || String(raw) });
        return;
      }

      // ── 2b. Diagram request — generate plan then auto-execute all steps ─
      socket.emit("reply", { type: "progress", message: "Planning…", step: 0, total: 0 });

      const planningClient = LLMClientFactory.getClient("plan");
      const boardCtx = summary ? ` Current board: ${summary}` : '';
      const planRaw = await planningClient.sendMessage({
        message: enforceMessageSize(message) + boardCtx
      });
      const planSteps = extractPlanSteps(planRaw, message);
      console.log(`[PLANNING] steps:`, planSteps);

      // Track accumulated element IDs so subsequent steps know what's on board
      const drawnElementIds = new Set((elements || []).map(e => e.id).filter(Boolean));
      let accumulatedSummary = session.summary;

      for (let i = 0; i < planSteps.length; i++) {
        const stepDesc = planSteps[i];
        socket.emit("reply", {
          type: "progress",
          message: stepDesc,
          step: i + 1,
          total: planSteps.length,
        });

        try {
          const thinkClient = LLMClientFactory.getClient("think");
          const ctx = buildDiagramContext({
            message,
            summary: accumulatedSummary,
            chatHistory: session.chatHistory,
            stepDesc,
          });
          const raw = await thinkClient.sendMessage({ message: ctx });
          const { reply, elements: skeletons } = extractElements(raw);

          let stepElements = Array.isArray(skeletons) ? skeletons : [];

          // Fallback: DiagramBuilder when LLM returns nothing
          if (stepElements.length === 0) {
            stepElements = diagramBuilder.buildSkeletons(stepDesc, drawnElementIds);
            console.log(`[FALLBACK] DiagramBuilder for step: "${stepDesc}"`, stepElements);
          }

          // Track new IDs for subsequent steps
          stepElements.forEach(el => { if (el.id) drawnElementIds.add(el.id); });

          // Update running summary for next step's context
          if (stepElements.length > 0) {
            accumulatedSummary = (accumulatedSummary ? accumulatedSummary + '; ' : '')
              + stepElements.map(el => `[${el.id || '?'}] ${el.type} label='${el.label?.text || ''}'`).join('; ');
          }

          socket.emit("reply", {
            type: "elements",
            elements: stepElements,
            reply: reply || `Step ${i + 1}: ${stepDesc}`,
            step: i + 1,
            total: planSteps.length,
          });
        } catch (stepErr) {
          console.error(`[STEP ${i + 1}] Error:`, stepErr);
          socket.emit("reply", {
            type: "progress",
            message: `Step ${i + 1} failed: ${stepErr.message}`,
            step: i + 1,
            total: planSteps.length,
          });
        }
      }

      socket.emit("reply", { type: "done", reply: "Diagram complete!" });

    } catch (err) {
      console.error(`[SOCKET] Error handling message:`, err);
      socket.emit("reply", { type: "error", reply: err.message || "Unknown error" });
    }
  });

  socket.on("disconnect", () => {
    console.log(`[SOCKET] Client disconnected: ${sessionId}`);
    delete sessions[sessionId];
  });
});

server.listen(port, "0.0.0.0",  () => {
  console.log(`Server running (WebSocket + HTTP) on http://0.0.0.0:${port}`);
});
