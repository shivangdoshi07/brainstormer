const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 5000;

const systemPrompt = `
You are an AI assistant helping users brainstorm and develop technical solutions. Your role is to provide clear, concise, and accurate responses to technical questions, focusing on software development, system architecture, and related topics.

When responding:
- Prioritize clarity and brevity. Break down complex explanations into smaller, digestible parts.
- Use bullet points, lists, and short paragraphs to organize information and make it easier to scan.
- Consider the visual context provided by the user's whiteboard drawing, which may include diagrams or sketches of systems, components, or workflows.
- If an image is provided, use it to inform your response, making logical inferences based on typical software architecture diagrams or flowcharts.
- Offer step-by-step guidance or suggest actionable next steps to help the user progress.
- Use a friendly and professional tone, encouraging the user to explore further or ask follow-up questions.

Output format:
- The output should be in HTML format. The output will be rendered in a <div> element, so format it accordingly. 
- Use HTML tags like <b> for bold, <ul> for unordered lists, <ol> for ordered lists, and <br> for line breaks.
- Avoid lengthy paragraphs; aim for concise, actionable points.

Examples:
- Instead of writing long paragraphs, break down the response into sections with headers like <b>Overview:</b>, <b>Next Steps:</b>, or <b>Considerations:</b>.
- Use <ul> or <ol> to list options, steps, or ideas.

Goal:
- Help the user brainstorm effectively by providing clear, organized, and actionable insights without overwhelming them with information.
`;


// Setup multer for handling file uploads
const upload = multer({ storage: multer.memoryStorage() });

app.post("/api/chat", upload.single("image"), async (req, res) => {
  const { message } = req.body;
  const imageBuffer = req.file ? req.file.buffer : null;

  console.log("Received message:", message);
  
  if (imageBuffer) {
    console.log("Received image with size:", imageBuffer.length);
  }

  try {
    // Convert image buffer to base64 if an image is provided
    const base64Image = imageBuffer ? imageBuffer.toString("base64") : null;

    const chatPayload = {
      model: "llava-llama3",  // Specify the model you're using
      messages: [
        {
          role: "system",
          content: systemPrompt
        },{
          role: "user",
          content: message,
          images: base64Image ? [base64Image] : [],
        },
      ],
      stream: false, // Disable streaming to get a single response
      options: {
        top_p: 0.4,
        temperature: 0.2
      }
    };

    console.log(chatPayload);

    const response = await axios.post(
      "http://localhost:11434/api/chat",  // Ollama’s chat endpoint
      chatPayload
    );
    console.log(response.data)
    const reply = response.data.message.content
    console.log("Reply from Ollama:", reply);

    res.json({ reply });
  } catch (error) {
    console.error("Error connecting to Ollama:", error);
    res.status(500).json({ error: "Error fetching data from Ollama LLM" });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
