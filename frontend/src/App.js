import React, { useRef } from "react";
import Whiteboard from "./components/Whiteboard";
import ChatOverlay from "./components/ChatOverlay";

function App() {
  const whiteboardRef = useRef(null);

  return (
    <div style={appContainerStyle}>
      <div style={excalidrawAreaStyle}>
        <Whiteboard ref={whiteboardRef} />
      </div>
      <div style={chatAreaStyle}>
        <ChatOverlay whiteboardRef={whiteboardRef} />
      </div>
    </div>
  );
}

export default App;

const appContainerStyle = {
  display: "flex",
  height: "100vh",
  width: "100vw",
  overflow: "hidden",
  margin: 0,
  padding: 0,
};

const excalidrawAreaStyle = {
  flex: 1,
  height: "100%",
  overflow: "hidden",
  position: "relative",
  backgroundColor: "#f0f0f0",
};

const chatAreaStyle = {
  width: "500px",
  height: "100%",
  flexShrink: 0,
  overflow: "hidden",
};