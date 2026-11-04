/**
 * Entrypoint của Peer Node Backend
 * Chạy: npx tsx peer/index.ts --name Alice --tcpPort 8001 --uiPort 3001
 */

import { PeerController } from "./peer-controller.js";
import { UIBridge } from "./ws/ui-bridge.js";

// Phân tích tham số CLI kết hợp Biến Môi trường (Hỗ trợ Docker và Local)
const args = process.argv.slice(2);
let displayName = process.env.PEER_NAME || "Peer_" + Math.floor(Math.random() * 1000);
let tcpPort = process.env.PEER_TCP_PORT ? parseInt(process.env.PEER_TCP_PORT, 10) : 8001;
let uiPort = process.env.PEER_UI_PORT ? parseInt(process.env.PEER_UI_PORT, 10) : 3001;
let registryPort = process.env.REGISTRY_PORT ? parseInt(process.env.REGISTRY_PORT, 10) : 7000;
let registryHost = process.env.REGISTRY_HOST || "127.0.0.1";
let advertiseIp = process.env.PEER_ADVERTISE_IP || "127.0.0.1";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--name" && args[i + 1]) displayName = args[i + 1];
  if (args[i] === "--tcpPort" && args[i + 1]) tcpPort = parseInt(args[i + 1], 10);
  if (args[i] === "--uiPort" && args[i + 1]) uiPort = parseInt(args[i + 1], 10);
  if (args[i] === "--registryPort" && args[i + 1]) registryPort = parseInt(args[i + 1], 10);
  if (args[i] === "--registryHost" && args[i + 1]) registryHost = args[i + 1];
  if (args[i] === "--ip" && args[i + 1]) advertiseIp = args[i + 1];
}

async function main() {
  const controller = new PeerController({
    displayName,
    tcpPort,
    ip: advertiseIp,
    registryHost,
    registryPort
  });

  const uiBridge = new UIBridge(controller, uiPort, controller.getLogger());

  console.log(`========================================================`);
  console.log(`🚀 Khởi động Peer: ${displayName}`);
  console.log(`   P2P Direct TCP Port: ${tcpPort}`);
  console.log(`   UI WebSocket Port  : ${uiPort}`);
  console.log(`   Registry Address   : ${registryHost}:${registryPort}`);
  console.log(`========================================================`);

  await controller.start();
  await uiBridge.start();

  process.on("SIGINT", async () => {
    console.log("\nĐang tắt Peer Node...");
    await uiBridge.close();
    await controller.close();
    console.log("Peer đã tắt an toàn.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Lỗi khởi động Peer:", err);
  process.exit(1);
});

