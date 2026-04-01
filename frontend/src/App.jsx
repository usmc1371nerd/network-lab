
import React, { useState, useCallback } from "react";
import NetworkCanvas from "./components/NetworkCanvas";
import Terminal from "./components/Terminal";
import PacketLog from "./components/PacketLog";

let _id = 1;
const uid = () => String(_id++);

export default function App() {
  const [devices, setDevices] = useState([]);
  const [connections, setConnections] = useState([]);
  const [capturedPackets, setCapturedPackets] = useState([]);
  const [displayedPackets, setDisplayedPackets] = useState([]);

  const addDevice = useCallback((type, x, y) => {
    const names = { pc: "PC", server: "Server", router: "Router", switch: "Switch" };
    const id = uid();
    setDevices((prev) => [
      ...prev,
      {
        id,
        type,
        name: `${names[type] || type}-${id}`,
        ip: "",
        x,
        y,
      },
    ]);
  }, []);

  const updateDevice = useCallback((id, fields) => {
    setDevices((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...fields } : d))
    );
  }, []);

  const removeDevice = useCallback((id) => {
    setDevices((prev) => prev.filter((d) => d.id !== id));
    setConnections((prev) =>
      prev.filter((c) => c.from !== id && c.to !== id)
    );
  }, []);

  const addConnection = useCallback((from, to) => {
    setConnections((prev) => {
      const exists = prev.some(
        (c) => (c.from === from && c.to === to) || (c.from === to && c.to === from)
      );
      return exists ? prev : [...prev, { from, to }];
    });
  }, []);

  const appendCapturedPackets = useCallback((newPkts) => {
    setCapturedPackets((prev) => {
      const offset = prev.length;
      return [
        ...prev,
        ...newPkts.map((p, i) => ({ ...p, no: offset + i + 1 })),
      ];
    });
  }, []);

  const clearCapturedPackets = useCallback(() => {
    setCapturedPackets([]);
    setDisplayedPackets([]);
  }, []);

  const showCapturedPackets = useCallback(() => {
    setDisplayedPackets(capturedPackets);
  }, [capturedPackets]);

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-logo">⬡</span>
        <h1 className="app-title">Network Lab</h1>
        <span className="app-subtitle">Interactive Network Simulator</span>
      </header>

      <div className="app-body">
        <div className="panel panel-canvas">
          <div className="panel-label">TOPOLOGY</div>
          <NetworkCanvas
            devices={devices}
            connections={connections}
            onAddDevice={addDevice}
            onUpdateDevice={updateDevice}
            onRemoveDevice={removeDevice}
            onAddConnection={addConnection}
          />
        </div>

        <div className="panel-right">
          <div className="panel panel-terminal">
            <div className="panel-label">TERMINAL</div>
            <Terminal
              devices={devices}
              packets={capturedPackets}
              onAppendPackets={appendCapturedPackets}
              onClearPackets={clearCapturedPackets}
              onShowPackets={showCapturedPackets}
            />
          </div>

          <div className="panel panel-packetlog">
            <div className="panel-label">PACKET LOG</div>
            <PacketLog packets={displayedPackets} />
          </div>
        </div>
      </div>
    </div>
  );
}
