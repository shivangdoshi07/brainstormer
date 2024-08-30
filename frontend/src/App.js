import React, { useRef } from "react";
import Whiteboard from "./components/Whiteboard";
import ChatOverlay from "./components/ChatOverlay";

function App() {
  const whiteboardRef = useRef(null); // Create a ref for the Whiteboard component

  return (
    <div style={appContainerStyle}> {/* Use flexbox for layout */}
      <Whiteboard ref={whiteboardRef} />
      <ChatOverlay whiteboardRef={whiteboardRef} />
    </div>
  );
}

export default App;

const appContainerStyle = {
  display: "flex",
  height: "100vh",  // Full viewport height
  width: "100vw",   // Full viewport width
  backgroundColor: "#f0f0f0",
};
