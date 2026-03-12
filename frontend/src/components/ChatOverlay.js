import React, { useState, useEffect, useRef } from "react";


import { io } from "socket.io-client";
export default function ChatOverlay({ whiteboardRef }) {
  const [message, setMessage] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [socket, setSocket] = useState(null);
  const [streamingReply, setStreamingReply] = useState("");
  const [plan, setPlan] = useState([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [mode, setMode] = useState("plan"); // 'plan' | 'chat'
  const textareaRef = useRef(null);

  useEffect(() => {
    const socketUrl = '/';
    const s = io(socketUrl, { transports: ["websocket"] });
    setSocket(s);

    s.on("llm_stream", (partial) => {
      setStreamingReply((prev) => prev + partial);
    });

    s.on("plan_generated", ({ steps, error }) => {
      setLoading(false);
      setStreamingReply("");
      if (error) {
        setChatHistory((prev) => [...prev, { sender: "bot", text: error }]);
        setPlan([]);
        setCurrentStepIndex(0);
        return;
      }
      setPlan(steps || []);
      setCurrentStepIndex(0);
    });

    s.on("step_done", ({ reply, newElements, nextStepIndex, planComplete }) => {
      setLoading(false);
      setStreamingReply("");
      setChatHistory((prev) => [...prev, { sender: "bot", text: reply }]);
      if (newElements && whiteboardRef.current && whiteboardRef.current.updateScene) {
        const { elements: current } = whiteboardRef.current.getSceneAndState();
        whiteboardRef.current.updateScene({ elements: [...current, ...newElements] });
      }
      if (nextStepIndex !== undefined) setCurrentStepIndex(nextStepIndex);
      // Optionally handle planComplete
    });

    s.on("chat_reply", ({ reply, newElements }) => {
      setLoading(false);
      setStreamingReply("");
      setChatHistory((prev) => [...prev, { sender: "bot", text: reply }]);
      if (newElements && newElements.length && whiteboardRef.current && whiteboardRef.current.updateScene) {
        const { elements: current } = whiteboardRef.current.getSceneAndState();
        whiteboardRef.current.updateScene({ elements: [...current, ...newElements] });
      }
    });

    s.on("plan", ({ reply, newElements, error }) => {
      setLoading(false);
      setStreamingReply("");
      if (error) {
        setChatHistory((prev) => [...prev, { sender: "bot", text: error }]);
        return;
      }
      setChatHistory((prev) => [...prev, { sender: "bot", text: reply }]);
      if (newElements && whiteboardRef.current && whiteboardRef.current.updateScene) {
        const { elements: current } = whiteboardRef.current.getSceneAndState();
        whiteboardRef.current.updateScene({ elements: [...current, ...newElements] });
      }
    });

    s.on("error", (err) => {
      setLoading(false);
      setStreamingReply("");
      setChatHistory((prev) => [...prev, { sender: "bot", text: err }]);
    });

    return () => {
      s.off("llm_stream");
      s.off("plan_generated");
      s.off("step_done");
      s.off("plan");
  s.off("chat_reply");
      s.off("error");
      s.disconnect();
    };
    // eslint-disable-next-line
  }, [whiteboardRef]);

  const handleSendMessage = () => {
    if (!socket || message.trim() === "") return;
    const userMsg = { sender: "user", text: message };
    const updatedHistory = [...chatHistory, userMsg];
    setChatHistory(updatedHistory);
    setMessage("");
    setLoading(true);
    setStreamingReply("");

    const { elements, appState } = whiteboardRef.current.getSceneAndState();
    const summary = whiteboardRef.current.summarizeScene();
    const payload = {
      message,
      elements,
      appState,
      chatHistory: updatedHistory,
      summary,
    };
    if (mode === 'plan') {
      socket.emit("user_message", payload);
    } else {
      socket.emit("chat_message", payload);
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
        {loading && <div>{streamingReply ? `Assistant: ${streamingReply}` : "Loading..."}</div>}
      </div>
      {/* Plan display and Next Step button */}
      {mode === 'plan' && plan.length > 0 && (
        <div style={{ padding: "10px", borderTop: "1px solid #eee" }}>
          <h4>Plan</h4>
          <ol>
            {plan.map((step, idx) => (
              <li key={idx} style={{ fontWeight: idx === currentStepIndex ? 'bold' : 'normal' }}>
                {step}
              </li>
            ))}
          </ol>
          {currentStepIndex < plan.length && (
            <button
              onClick={() => socket.emit("continue_step")}
              disabled={loading}
              style={buttonStyle}
            >
              {loading ? "Working..." : "Next Step"}
            </button>
          )}
        </div>
      )}
      <div style={inputContainerStyle}>
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={modeSelectStyle}>
          <option value="plan">Plan Mode</option>
          <option value="chat">Chat Mode</option>
        </select>
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
  height: "100%",
  backgroundColor: "white",
  borderLeft: "1px solid #ccc",
  boxShadow: "-4px 0 12px rgba(0, 0, 0, 0.1)",
  overflow: "hidden",
};

const chatHistoryStyle = {
  flex: 1,
  padding: "10px",
  overflowY: "auto", // Change from "scroll" to "auto"
  borderBottom: "1px solid #ccc",
  whiteSpace: "pre-wrap",
  minHeight: 0,
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

const modeSelectStyle = {
  marginRight: "10px",
  padding: "6px 8px",
  border: "1px solid #ccc",
  borderRadius: "4px",
  background: "#fff",
};
