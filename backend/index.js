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
            description: "A short verb phrase describing what the user wants (e.g., 'draw diagram', 'modify diagram', 'explain concept', 'chat')"
          },
          type: {
            type: "string",
            enum: ["think", "multimodal", "chat"],
            description: "The type of model to use: 'think' for any diagram creation, modification, or visual explanation — 'multimodal' only if user explicitly asks to analyze an uploaded image — 'chat' for pure conversation with no visual component"
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
      description: "Add shapes, connections, and free-floating text to the whiteboard. Diagrams should ARGUE visually — the structure itself should communicate relationships and flow, not just label boxes.",
      parameters: {
        type: "object",
        properties: {
          reply: {
            type: "string",
            description: "A friendly, collaborative message explaining the design choices you made — be conversational, like a teammate thinking out loud. Mention why you chose the layout or shapes, and invite feedback."
          },
          elements: {
            type: "array",
            description: "Array of Excalidraw element skeletons. Mix shapes, free-floating text, and arrows to create visual arguments, not just box grids.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Descriptive unique ID (e.g. 'user-actor', 'api-gateway', 'postgres-db')" },
                type: {
                  type: "string",
                  enum: ["rectangle", "ellipse", "diamond", "arrow", "line", "text"],
                  description: "Shape type with semantic meaning: ellipse=actors/users/endpoints, rectangle=services/processes/components, diamond=decisions/routers/gateways, text=free-floating labels/section titles/annotations (no container needed), arrow=directed flow/relationship, line=structural dividers/timelines"
                },
                x: { type: "number", description: "X coordinate (increases rightward)" },
                y: { type: "number", description: "Y coordinate (increases downward)" },
                width: { type: "number", description: "Width in pixels (shapes only)" },
                height: { type: "number", description: "Height in pixels (shapes only)" },
                label: {
                  type: "object",
                  description: "Text label for shapes (rectangle, ellipse, diamond)",
                  properties: {
                    text: { type: "string", description: "Label text" },
                    fontSize: { type: "number", description: "Font size (default 16)" }
                  },
                  required: ["text"]
                },
                text: { type: "string", description: "Text content for free-floating text elements (type='text' only)" },
                fontSize: { type: "number", description: "Font size for text elements (default 18 for section titles, 14 for annotations)" },
                strokeColor: {
                  type: "string",
                  description: "Border/stroke color (hex). Semantic palette: users/actors=#2563eb, services/backends=#16a34a, databases/storage=#9333ea, gateways/LB/CDN=#ea580c, queues/events=#ca8a04, external/3rd-party=#64748b"
                },
                backgroundColor: {
                  type: "string",
                  description: "Fill color (hex). Semantic palette: users/actors=#dbeafe, services/backends=#dcfce7, databases/storage=#f3e8ff, gateways/LB/CDN=#ffedd5, queues/events=#fef9c3, external/3rd-party=#f1f5f9"
                },
                roughness: { type: "number", description: "0=clean crisp lines (default), 1=hand-drawn feel" },
                strokeWidth: { type: "number", description: "Line thickness: 1=thin/subtle, 2=standard (default for shapes), 1.5=arrows" },
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
      description: "Plan what to draw on the whiteboard, including the layout pattern and each component's semantic role",
      parameters: {
        type: "object",
        properties: {
          diagram_type: {
            type: "string",
            enum: ["hierarchical", "pipeline", "fan-out", "convergence", "cycle", "side-by-side", "timeline"],
            description: "The visual layout pattern that best fits this concept. hierarchical=layered system architecture, pipeline=sequential data/process flow, fan-out=one source to many consumers, convergence=many inputs to one output, cycle=feedback loop or iterative process, side-by-side=comparison or before/after, timeline=event sequence or lifecycle"
          },
          steps: {
            type: "array",
            description: "Components and connections to draw. Tag each with its semantic role in brackets so the diagram AI picks the right shape and color.",
            items: {
              type: "string",
              description: "Component or connection description with role tag. Examples: 'User [actor] - initiates requests', 'API Gateway [gateway] - routes traffic', 'Auth Service [service] - validates tokens', 'PostgreSQL [storage] - persists user data', 'Connect User to API Gateway'"
            }
          }
        },
        required: ["diagram_type", "steps"]
      }
    }
  }
};

// System prompts for each client
const SYSTEM_PROMPTS = {
  fast: `You are a fast intent classifier for the Brainstormer whiteboarding app. Use classify_intent to categorize the user's request.

Set type to:
- "think" for anything visual: creating diagrams, modifying diagrams, explaining concepts visually, brainstorming with a diagram, adding/removing/editing elements
- "multimodal" ONLY if the user explicitly says to analyze an uploaded image or screenshot
- "chat" ONLY for pure conversation with no visual component (e.g., "what is a load balancer?", "thanks", "can you explain X?")

When in doubt between "think" and "chat", choose "think" — it's better to draw too much than too little.`,

  think: `You are a visual thinker and collaborative design partner on a shared whiteboard. Your job is to draw diagrams that ARGUE — the visual structure itself should communicate relationships, causality, and flow that words alone can't express.

STEP 1 — CHOOSE A VISUAL PATTERN that mirrors the concept:
  • HIERARCHICAL: Layered top-to-bottom (actors → gateways → services → storage). Best for system architectures, infrastructure.
  • PIPELINE: Left-to-right row of steps. Best for data flows, ETL, CI/CD, sequential processes.
  • FAN-OUT: Central hub radiating arrows outward. Best for APIs serving many consumers, event sources, pub/sub.
  • CONVERGENCE: Multiple inputs merging into one output. Best for aggregation, search indexing, funnels.
  • CYCLE: Elements in a loop with a return arrow. Best for request-response, feedback loops, iterative processes.
  • SIDE-BY-SIDE: Two parallel groups. Best for before/after, client vs server, comparisons, alternatives.
  • TIMELINE: Horizontal line with dots and labels. Best for event sequences, lifecycle phases, steps over time.

STEP 2 — ASSIGN SHAPES WITH SEMANTIC MEANING (the shape should BE the meaning):
  • ellipse → actors, users, external systems, start/end points
  • rectangle → services, backends, components, processes, actions
  • diamond → decisions, routers, load balancers, API gateways, conditions
  • text (no container) → section titles, layer labels, annotations, descriptions — use freely, default to text instead of a box when no arrow connects to it

STEP 3 — APPLY SEMANTIC COLORS (encode role with color, not decoration):
  • Users / Clients / Actors:        backgroundColor="#dbeafe"  strokeColor="#2563eb"
  • Services / Backends / APIs:      backgroundColor="#dcfce7"  strokeColor="#16a34a"
  • Databases / Storage / Caches:    backgroundColor="#f3e8ff"  strokeColor="#9333ea"
  • Gateways / Load Balancers / CDN: backgroundColor="#ffedd5"  strokeColor="#ea580c"
  • Queues / Events / Async:         backgroundColor="#fef9c3"  strokeColor="#ca8a04"
  • External / Third-party:          backgroundColor="#f1f5f9"  strokeColor="#64748b"

STEP 4 — LAYOUT COORDINATES by pattern:
  Hierarchical: y=100 (actors), y=270 (gateways/CDN/LB), y=440 (services), y=610 (databases/queues). x=100 + index*(width+80) per tier.
  Pipeline:     y=260, x=100 + index*(width+80).
  Fan-out:      Center at (460, 260). Targets spread at x=700, y staggered by 140px starting at y=100.
  Convergence:  Sources at x=100, y staggered. Output at x=500, y=260.
  Cycle:        3 nodes: (200,160) (500,160) (350,380). 4 nodes: corners of a 400x280 rectangle starting at (100,100).
  Side-by-side: Left group x=80–380, right group x=520–820. Add a vertical divider line at x=460.
  Timeline:     Horizontal line (type="line") at y=300 from x=80 to x=max. Dot (ellipse 14×14) every 220px. Label (text) at y=250 above each dot.

STEP 5 — ADD FREE-FLOATING TEXT for context:
  • Add section/layer labels as text elements (type="text", fontSize=15, no shape around them)
  • Example: { "type": "text", "id": "label-frontend", "x": 40, "y": 75, "text": "Frontend", "fontSize": 15 }

STEP 6 — SIZE shapes by label length:
  ≤10 chars → width=160, 11-18 chars → width=200, >18 chars → width=240. height=60 for all shapes.

STEP 7 — ADD ARROWS after all shapes. x=0, y=0 always for arrows. roughness=0, strokeWidth=1.5.

CONTAINER DISCIPLINE — not every piece of text needs a shape. Ask: "does an arrow connect to this?" If no, use type="text" instead of a box. Aim for visual variety, not a uniform grid of rectangles.

QUALITY CHECK before returning:
  - Does the visual structure alone communicate the concept? (remove text mentally — does it still make sense?)
  - Are section labels present to orient the viewer?
  - Are colors consistent with semantic roles?
  - Is there visual variety (mix of shapes, text, arrows)?

RULES:
  - roughness=0 and strokeWidth=2 for all shapes (clean, professional look)
  - IDs: descriptive and unique (e.g. "api-gateway", "user-actor", "postgres-db")
  - Never reuse an ID from EXISTING BOARD ELEMENTS
  - If board has elements: read their positions to extend layout consistently
  - Return ALL elements (shapes, text labels, arrows) in one array
  - Return empty elements array only if the user is chatting with no diagram request
  - In your reply: be a collaborative design partner — explain your layout choices briefly and invite feedback`,

  multimodal: `You are a visual design partner on a collaborative whiteboard. You receive a board summary and optionally a diagram image. Use add_diagram_elements to respond. Apply shape semantics (ellipse=actors, diamond=decisions/gateways, rectangle=services), semantic colors (users=#dbeafe/#2563eb, services=#dcfce7/#16a34a, databases=#f3e8ff/#9333ea), and use free-floating text (type="text") for labels that don't need arrows. If the user wants analysis only, return empty elements and explain in reply.`,

  plan: `You are a visual planning agent for a collaborative whiteboard. Given a user's request, plan what to draw.

FIRST: Identify the best visual pattern (diagram_type):
  - hierarchical: layered system (actors → gateways → services → storage)
  - pipeline: sequential left-to-right flow (data pipelines, ETL, CI/CD)
  - fan-out: one source distributing to many consumers (pub/sub, APIs)
  - convergence: many inputs merging into one output (aggregation, indexing)
  - cycle: loop or feedback pattern (request-response, iterative)
  - side-by-side: two parallel groups (comparison, client vs server)
  - timeline: event sequence or lifecycle (user journey, deployment steps)

THEN: List each component as a short step tagged with its semantic role:
  - [actor] for users, clients, browsers, mobile apps
  - [gateway] for load balancers, API gateways, CDNs, reverse proxies
  - [service] for backend services, APIs, workers, processors
  - [storage] for databases, caches, queues, blob stores, file systems
  - [external] for third-party services, SaaS, external APIs

Format: "ComponentName [role] - one-line description"
Then add connection steps: "Connect ComponentA to ComponentB"

Do NOT repeat the user's request verbatim as a step. If the task is simple, return a minimal but complete plan.`
};
function extractPlanSteps(planData, message) {
  let planSteps;
  try {
    // If planData is already an object with steps property (from tool call)
    // Also capture diagram_type if present
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

// Build the context string sent to the diagram model.
// Board summary comes first and is called out clearly so the LLM reads it
// before deciding where to place elements.
function buildDiagramContext({ message, summary, chatHistory, allSteps, diagramType }) {
  const historyText = tailChat(chatHistory || [])
    .map(h => `${h.sender}: ${enforceMessageSize(h.text)}`)
    .join('\n');
  const boardCtx = summary
    ? `\nEXISTING BOARD ELEMENTS (format: [id] type (x,y) WxH label='...' — read positions to extend layout correctly):\n${summary}`
    : '\nBoard is empty — place first shape at x=100, y=260.';
  const layoutHint = diagramType
    ? `\nSUGGESTED LAYOUT PATTERN: ${diagramType} — use this pattern unless the components clearly call for a different one.`
    : '';
  const components = allSteps?.length
    ? `\nCOMPONENTS TO ADD (each tagged with semantic role — use role to assign shape type and color):\n${allSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';
  const userReq = `\nUSER REQUEST: ${enforceMessageSize(message)}`;
  const history = historyText ? `\nRecent chat:\n${historyText}` : '';
  return `${boardCtx}${layoutHint}${components}${userReq}${history}`;
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

      // ── 2b. Diagram request — plan then draw entire diagram in one LLM call ─
      // Planning and drawing are kept as two separate steps so the diagram LLM
      // sees ALL components at once and can make globally-optimal layout decisions.

      socket.emit("reply", { type: "progress", message: "Planning…", step: 1, total: 2 });

      const planningClient = LLMClientFactory.getClient("plan");
      const boardCtx = summary ? ` Current board: ${summary}` : '';
      const planRaw = await planningClient.sendMessage({
        message: enforceMessageSize(message) + boardCtx
      });
      const planSteps = extractPlanSteps(planRaw, message);
      // Extract diagram_type from the raw plan response if available
      const diagramType = (typeof planRaw === 'object' && planRaw.diagram_type) ? planRaw.diagram_type : null;
      console.log(`[PLANNING] diagram_type: ${diagramType}, steps:`, planSteps);

      socket.emit("reply", { type: "progress", message: "Drawing diagram…", step: 2, total: 2 });

      // Single diagram LLM call with ALL steps — enables globally-optimal layout
      const thinkClient = LLMClientFactory.getClient("think");
      const ctx = buildDiagramContext({
        message,
        summary: session.summary,
        chatHistory: session.chatHistory,
        allSteps: planSteps,
        diagramType,
      });
      const raw = await thinkClient.sendMessage({ message: ctx });
      const { reply, elements: skeletons } = extractElements(raw);

      let allElements = Array.isArray(skeletons) ? skeletons : [];

      // Fallback: DiagramBuilder for each step when LLM returns nothing
      if (allElements.length === 0) {
        const drawnIds = new Set((elements || []).map(e => e.id).filter(Boolean));
        for (const stepDesc of planSteps) {
          const fallback = diagramBuilder.buildSkeletons(stepDesc, drawnIds);
          fallback.forEach(el => { if (el.id) drawnIds.add(el.id); });
          allElements.push(...fallback);
        }
        console.log(`[FALLBACK] DiagramBuilder produced ${allElements.length} elements`);
      }

      socket.emit("reply", {
        type: "elements",
        elements: allElements,
        reply: reply || "Here's your diagram! Let me know if you'd like to adjust anything.",
        step: 2,
        total: 2,
      });

      socket.emit("reply", { type: "done", reply: "" });

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
