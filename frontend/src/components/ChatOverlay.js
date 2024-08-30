import React, { useState, useEffect, useRef } from "react";
import axios from "axios";

export default function ChatOverlay({ whiteboardRef }) {
  const [message, setMessage] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef(null);

  const handleSendMessage = async () => {
    if (message.trim() === "") return;

    setChatHistory((prevHistory) => [...prevHistory, { sender: "user", text: message }]);
    setMessage(""); // Clear the input field

    setLoading(true);

    try {
      const imageBlob = await whiteboardRef.current.exportToImage();

      const formData = new FormData();
      formData.append("message", message);
      if (imageBlob) {
        formData.append("image", imageBlob, "whiteboard.png");
      }

      const response = await axios.post("http://localhost:5001/api/chat", formData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      });

      setChatHistory((prevHistory) => [
        ...prevHistory,
        { sender: "bot", text: response.data.reply },
      ]);
    } catch (error) {
      console.error("Error fetching response from backend:", error);
      setChatHistory((prevHistory) => [
        ...prevHistory,
        { sender: "bot", text: "Error connecting to LLM" },
      ]);
    } finally {
      setLoading(false);
    }
  };

  // Adjust textarea height based on content
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [message]);

  return (
    <div style={overlayStyle}>
      <div style={chatHistoryStyle}>
        {chatHistory.map((chat, index) => (
          <div key={index} style={{ marginBottom: "10px" }}>
            <strong>{chat.sender === "user" ? "You" : "Bot"}:</strong>
            <div style={{ whiteSpace: "pre-wrap" }}>{chat.text}</div>
          </div>
        ))}
        {loading && <div>Loading...</div>}
      </div>
      <div style={inputContainerStyle}>
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Type your message..."
          style={textareaStyle}
          rows={1} // Start with one row, grow as needed
        />
        <button onClick={handleSendMessage} style={buttonStyle}>
          Send
        </button>
      </div>
    </div>
  );
}

// Styles for the overlay and chat components
const overlayStyle = {
  display: "flex",
  flexDirection: "column",
  height: "100%", // Full height of the screen
  backgroundColor: "white",
  borderRadius: "10px",
  boxShadow: "0px 4px 12px rgba(0, 0, 0, 0.1)",
  zIndex: 10,
  width: "500px", // Fixed width for the chat overlay
};

const chatHistoryStyle = {
  flex: 1,
  padding: "10px",
  overflowY: "scroll",
  borderBottom: "1px solid #ccc",
  whiteSpace: "pre-wrap",
};

const inputContainerStyle = {
  display: "flex",
  alignItems: "flex-end",
  padding: "10px",
  borderTop: "1px solid #ccc",
};

const textareaStyle = {
  flex: 1,
  padding: "8px",
  border: "1px solid #ccc",
  borderRadius: "4px",
  resize: "none", // Disable manual resizing, we'll handle it programmatically
  fontFamily: "inherit",
  fontSize: "inherit",
  overflow: "hidden",
  lineHeight: "1.5",
};

const buttonStyle = {
  padding: "8px 12px",
  marginLeft: "10px",
  backgroundColor: "#007bff",
  color: "white",
  border: "none",
  borderRadius: "4px",
  cursor: "pointer",
};
