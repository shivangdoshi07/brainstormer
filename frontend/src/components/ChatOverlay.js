import React, { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";

// Inject keyframe animation once
const STYLE_ID = "brainstormer-dot-anim";
if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes bm-bounce {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
      40%            { transform: translateY(-5px); opacity: 1; }
    }
    .bm-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #94a3b8;
      display: inline-block;
      animation: bm-bounce 1.2s ease-in-out infinite;
    }
    .bm-dot:nth-child(1) { animation-delay: 0s; }
    .bm-dot:nth-child(2) { animation-delay: 0.2s; }
    .bm-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bm-progress {
      from { background-position: 0 0; }
      to   { background-position: 40px 0; }
    }
  `;
  document.head.appendChild(style);
}

export default function ChatOverlay({ whiteboardRef }) {
  const [message, setMessage] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null); // { message, step, total }
  const [socket, setSocket] = useState(null);
  const textareaRef = useRef(null);
  const chatBottomRef = useRef(null);

  useEffect(() => {
    const s = io("/", { transports: ["websocket"] });
    setSocket(s);

    // Single reply event — typed by payload.type
    s.on("reply", (payload) => {
      switch (payload.type) {
        case "chat":
          setLoading(false);
          setProgress(null);
          setChatHistory((prev) => [...prev, { sender: "bot", text: payload.reply }]);
          break;

        case "progress":
          setProgress({
            message: payload.message,
            step: payload.step,
            total: payload.total,
          });
          break;

        case "elements":
          if (payload.reply) {
            setChatHistory((prev) => [...prev, { sender: "bot", text: payload.reply }]);
          }
          if (payload.elements?.length && whiteboardRef.current?.addElements) {
            whiteboardRef.current.addElements(payload.elements);
          }
          // Update progress step counter if part of a plan
          if (payload.step != null && payload.total != null) {
            setProgress((prev) =>
              prev ? { ...prev, step: payload.step, total: payload.total } : null
            );
          }
          break;

        case "done":
          setLoading(false);
          setProgress(null);
          if (payload.reply) {
            setChatHistory((prev) => [...prev, { sender: "bot", text: payload.reply }]);
          }
          break;

        case "error":
          setLoading(false);
          setProgress(null);
          setChatHistory((prev) => [
            ...prev,
            { sender: "bot", text: `Error: ${payload.reply}` },
          ]);
          break;

        default:
          break;
      }
    });

    s.on("connect_error", () => {
      setLoading(false);
      setProgress(null);
      setChatHistory((prev) => [
        ...prev,
        { sender: "bot", text: "Connection error. Please refresh." },
      ]);
    });

    return () => {
      s.off("reply");
      s.off("connect_error");
      s.disconnect();
    };
    // eslint-disable-next-line
  }, [whiteboardRef]);

  // Auto-scroll to bottom on new messages or progress changes
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, progress]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [message]);

  const handleSend = () => {
    if (!socket || message.trim() === "" || loading) return;

    const userMsg = { sender: "user", text: message };
    const updatedHistory = [...chatHistory, userMsg];
    setChatHistory(updatedHistory);
    setMessage("");
    setLoading(true);
    setProgress(null);

    const elements = whiteboardRef.current?.getSceneElements() ?? [];
    const summary = whiteboardRef.current?.summarizeScene() ?? "";

    socket.emit("message", {
      message: message.trim(),
      elements,
      summary,
      chatHistory: updatedHistory,
    });
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClearBoard = () => {
    whiteboardRef.current?.clearScene();
  };

  return (
    <div style={styles.overlay}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>Brainstormer</span>
        <button onClick={handleClearBoard} style={styles.clearBtn} title="Clear board">
          Clear board
        </button>
      </div>

      {/* Chat history */}
      <div style={styles.chatHistory}>
        {chatHistory.length === 0 && (
          <div style={styles.emptyState}>
            Ask me to draw a diagram, brainstorm ideas, or explain what's on the board.
          </div>
        )}
        {chatHistory.map((chat, index) => (
          <div
            key={index}
            style={chat.sender === "user" ? styles.userBubble : styles.botBubble}
          >
            <div style={styles.bubbleLabel}>
              {chat.sender === "user" ? "You" : "Assistant"}
            </div>
            <div style={styles.bubbleText}>{chat.text}</div>
          </div>
        ))}

        {/* Inline status bubble — visible from the moment the user sends */}
        {loading && (
          <div style={styles.botBubble}>
            <div style={styles.bubbleLabel}>Assistant</div>
            <div style={styles.statusBubble}>
              <div style={styles.statusTop}>
                <span className="bm-dot" />
                <span className="bm-dot" />
                <span className="bm-dot" />
                <span style={styles.statusText}>
                  {progress ? progress.message : "Thinking…"}
                </span>
              </div>
              {progress && progress.total > 0 && (
                <div style={styles.statusBar}>
                  <div
                    style={{
                      ...styles.statusFill,
                      width: `${Math.round((progress.step / progress.total) * 100)}%`,
                    }}
                  />
                </div>
              )}
              {progress && progress.total > 0 && (
                <div style={styles.statusStep}>
                  Step {progress.step} of {progress.total}
                </div>
              )}
            </div>
          </div>
        )}

        <div ref={chatBottomRef} />
      </div>

      {/* Input row */}
      <div style={styles.inputRow}>
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask me to draw something, or just chat… (Enter to send)"
          style={styles.textarea}
          rows={1}
          disabled={loading}
        />
        <button onClick={handleSend} style={styles.sendBtn} disabled={loading}>
          {loading ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    backgroundColor: "#fafafa",
    borderLeft: "1px solid #e0e0e0",
    boxShadow: "-4px 0 12px rgba(0,0,0,0.06)",
    overflow: "hidden",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #e0e0e0",
    backgroundColor: "#fff",
    flexShrink: 0,
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: "15px",
    color: "#1a1a1a",
  },
  clearBtn: {
    padding: "4px 10px",
    fontSize: "12px",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    background: "#fff",
    cursor: "pointer",
    color: "#555",
  },
  chatHistory: {
    flex: 1,
    padding: "12px 14px",
    overflowY: "auto",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  emptyState: {
    color: "#999",
    fontSize: "13px",
    textAlign: "center",
    marginTop: "40px",
    lineHeight: 1.5,
    padding: "0 20px",
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
  },
  botBubble: {
    alignSelf: "flex-start",
    maxWidth: "95%",
  },
  bubbleLabel: {
    fontSize: "11px",
    color: "#888",
    marginBottom: "3px",
    fontWeight: 500,
  },
  bubbleText: {
    backgroundColor: "#fff",
    border: "1px solid #e4e4e4",
    borderRadius: "8px",
    padding: "8px 12px",
    fontSize: "13px",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    color: "#1a1a1a",
  },
  statusBubble: {
    backgroundColor: "#fff",
    border: "1px solid #e4e4e4",
    borderRadius: "8px",
    padding: "10px 14px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    minWidth: "140px",
  },
  statusTop: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  statusText: {
    fontSize: "13px",
    color: "#64748b",
    marginLeft: "2px",
  },
  statusBar: {
    height: "3px",
    backgroundColor: "#e2e8f0",
    borderRadius: "2px",
    overflow: "hidden",
  },
  statusFill: {
    height: "100%",
    backgroundColor: "#4a90e2",
    borderRadius: "2px",
    transition: "width 0.4s ease",
  },
  statusStep: {
    fontSize: "11px",
    color: "#94a3b8",
  },
  inputRow: {
    display: "flex",
    alignItems: "flex-end",
    padding: "10px 12px",
    borderTop: "1px solid #e0e0e0",
    backgroundColor: "#fff",
    gap: "8px",
    flexShrink: 0,
  },
  textarea: {
    flex: 1,
    padding: "9px 12px",
    border: "1px solid #d0d0d0",
    borderRadius: "6px",
    resize: "none",
    fontFamily: "inherit",
    fontSize: "13px",
    lineHeight: 1.5,
    overflow: "hidden",
    maxHeight: "120px",
    outline: "none",
    backgroundColor: "#fff",
    color: "#1a1a1a",
  },
  sendBtn: {
    padding: "9px 16px",
    backgroundColor: "#4a90e2",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 500,
    flexShrink: 0,
    opacity: 1,
  },
};
