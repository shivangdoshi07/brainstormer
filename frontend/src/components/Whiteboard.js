import React, { useImperativeHandle, forwardRef, useRef } from "react";
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";

const whiteboardStyle = {
  flex: 1,  // This allows the whiteboard to take up the remaining space
  height: "100%", // Ensure it takes the full height of the container
  border: "1px solid #ccc",
  marginBottom: "20px",
};

const Whiteboard = forwardRef((props, ref) => {
  const excalidrawRef = useRef(null);

  useImperativeHandle(ref, () => ({
    exportToImage: async () => {
      if (excalidrawRef.current) {
        const blob = await exportToBlob({
          elements: excalidrawRef.current.getSceneElements(),
          appState: excalidrawRef.current.getAppState(),
          mimeType: "image/png",
        });
        return blob;
      }
      return null;
    },
  }));

  return (
    <div style={whiteboardStyle}>
      <Excalidraw ref={excalidrawRef} />
    </div>
  );
  
});

export default Whiteboard;
