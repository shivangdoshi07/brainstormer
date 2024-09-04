# Brainstormer: AI-Powered Multi-Modal Whiteboarding Tool
Brainstormer — Interactive Whiteboard with Multi-Modal AI Assistant

Brainstormer is an innovative tool designed to enhance your brainstorming sessions, system design, and creative thinking by combining a dynamic, interactive whiteboard with the power of AI. Whether you're sketching out complex software architectures or generating new ideas, Brainstormer seamlessly integrates a smart whiteboard with AI-driven insights to make your process more efficient and visually intuitive.

## Features

- **Interactive Whiteboard**: Powered by [Excalidraw](https://excalidraw.com/), Brainstormer offers a flexible and easy-to-use whiteboard for sketching ideas, system designs, and more.
- **AI-Driven Chat**: Integrated with an LLM like [Ollama](https://ollama.com/), Brainstormer provides intelligent responses and suggestions based on your whiteboard sketches and text inputs.
- **Multimodal Interaction**: Export your whiteboard as an image and use it as context within the chat, allowing the AI to provide more relevant and targeted advice.
- **Responsive Design**: The layout adapts to different screen sizes, providing a seamless experience whether on desktop or mobile devices.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v14 or higher)
- [npm](https://www.npmjs.com/) (v6 or higher)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/shivangdoshi07/brainstormer.git
   cd brainstormer
   ```

2. Install the dependencies:
    ```bash
    npm install
    ```
3. Start the backend server:
    ```bash
    cd backend
    node index.js
    ```
4. Start the frontend development server:
    ```bash
    cd frontend
    npm start
    ```
5. Open your browser and navigate to http://localhost:3000 to start using Brainstormer.

### Roadmap
- [ ] Set System Prompt Using User Input: Allow users to customize the system prompt for the AI, tailoring responses to specific needs and preferences.
- [ ] Pass Chat History to the Chat Completion API: Instead of only sending the most recent message, the full chat history will be passed to the API, enabling the AI to maintain context over longer conversations.
- [ ] Convert Whiteboard Elements to Text: Enhance the AI's understanding by exporting scene elements from Excalidraw and converting them to text, rather than just using an image.
- [ ] Add LLM Router: Implement a router that intelligently directs chat input to either a pure LLM or a vision-enabled LLM based on the type of question.
- [ ] Function Calling for Whiteboard Updates: Introduce function calling capabilities, allowing the AI to directly add new elements to the whiteboard based on the conversation.

### Acknowledgements
* [Excalidraw](https://excalidraw.com/) for the whiteboard functionality.
* Ollama for the LLM API integration.
