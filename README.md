# Hệ thống Chat & Chia sẻ File P2P Bảo mật với KDC
## Đề tài môn học: Các hệ thống phân tán (Distributed Systems)

Dự án triển khai theo kiến trúc mạng phân tán Peer-to-Peer (P2P) kết hợp mô hình Trung tâm Phân phối Khóa (Key Distribution Center - KDC).

---

## 📌 PHẠM VI GIAI ĐOẠN 1
- **Phần phân tán**: Registry Node (Mock KDC), Peer Backend mở kết nối TCP Socket thô trực tiếp giữa các Peer, cơ chế Framing 4-bytes Length-prefixed chống vỡ/dính gói tin, chia nhỏ file thành chunk 64KB, hàng đợi tin nhắn offline, chống trùng tin nhắn qua UUID (`message_id`).
- **Lưu trữ cục bộ**: Mỗi Peer sở hữu database SQLite độc lập (`better-sqlite3` / `node:sqlite`), tối ưu hóa RAM với WAL mode và giới hạn cache 2MB.
- **Giao diện**: React + Vite + Tailwind CSS với bố cục 3 vùng (Sidebar danh sách peer, Khung chat & tiến độ file, Panel xem Protocol Logs trực tiếp).
- **Trạng thái bảo mật**: Truyền **Plaintext** (có chủ đích) phục vụ bắt gói tin Wireshark so sánh trước/sau khi cài đặt KDC và mã hóa ở Giai đoạn 2.

---

## 🛠️ CÀI ĐẶT & CHUẨN BỊ
Yêu cầu: **Node.js v20+** (Khuyến nghị Node.js v22 hoặc v24).

```bash
# Cài đặt thư viện Backend
npm install

# Cài đặt thư viện Frontend UI
cd ui
npm install
cd ..
```

---

## 🐳 CÁCH 1: CHẠY BACKEND TRÊN DOCKER + FRONTEND TRÊN TERMINAL (KHUYẾN NGHỊ)

Toàn bộ **Registry và 3 Peer Backend (Alice, Bob, Charlie)** được đóng gói chạy tự động trong Docker; **Frontend UI** chạy trực tiếp trên terminal của máy bạn.

### Bước 1: Khởi động toàn bộ Backend trong Docker
```bash
docker compose up -d
```
Lệnh này sẽ tự động khởi động:
- `p2p-registry` trên cổng `7000`
- `p2p-peer-alice` trên TCP `8001`, WebSocket UI `3001`
- `p2p-peer-bob` trên TCP `8002`, WebSocket UI `3002`
- `p2p-peer-charlie` trên TCP `8003`, WebSocket UI `3003`
*(Dữ liệu SQLite được đồng bộ ra thư mục `./data` trên máy bạn; file tải về nằm tại `./downloads`)*.

### Bước 2: Khởi động React Frontend UI trên Terminal
Mở một cửa sổ Terminal trên máy bạn:
```bash
cd ui
npm run dev
```

### Bước 3: Mở trình duyệt trải nghiệm
- **Alice**: [http://localhost:5173/?port=3001](http://localhost:5173/?port=3001)
- **Bob**: [http://localhost:5173/?port=3002](http://localhost:5173/?port=3002)
- **Charlie**: [http://localhost:5173/?port=3003](http://localhost:5173/?port=3003)

Khi muốn dừng Docker:
```bash
docker compose down
```

---

## 💻 CÁCH 2: CHẠY THỦ CÔNG TRÊN TERMINAL (KHÔNG DÙNG DOCKER)

### 1. Khởi động Registry (Mock KDC)
```bash
npm run registry
# Lắng nghe tại TCP port 7000
```

### 2. Khởi động các Peer Backend
Mở các cửa sổ Terminal riêng:

```bash
# Terminal Peer 1 (Alice):
npx tsx peer/index.ts --name Alice --tcpPort 8001 --uiPort 3001

# Terminal Peer 2 (Bob):
npx tsx peer/index.ts --name Bob --tcpPort 8002 --uiPort 3002

# Terminal Peer 3 (Charlie):
npx tsx peer/index.ts --name Charlie --tcpPort 8003 --uiPort 3003
```

### 3. Khởi động React UI
```bash
cd ui
npm run dev
```
Mở trình duyệt:
- Tab 1: `http://localhost:5173/?port=3001` (Giao diện của Alice)
- Tab 2: `http://localhost:5173/?port=3002` (Giao diện của Bob)
- Tab 3: `http://localhost:5173/?port=3003` (Giao diện của Charlie)

---

## 🧪 CHẠY BỘ KIỂM THỬ TỰ ĐỘNG (AUTOMATED TEST SUITE)

Hệ thống có đầy đủ kịch bản kiểm thử tự động cho từng mốc:

```bash
# Kiểm thử Mốc 1: Registry, Đăng ký, Từ chối trùng tên, Heartbeat & Timeout
npx tsx tests/test-m1-registry.ts

# Kiểm thử Mốc 2: Chat 1-1 qua TCP, ACK, Deduplication & Hàng đợi tin offline
npx tsx tests/test-m2-chat.ts

# Kiểm thử Mốc 3: Truyền file chunk 64KB, ghép nối và kiểm tra tính toàn vẹn Checksum
npx tsx tests/test-m3-file.ts

# Kiểm thử Mốc 4: Cầu nối WebSocket giữa React UI và Peer Backend
npx tsx tests/test-m4-ui-bridge.ts

# Kiểm thử Mốc 5: Kịch bản toàn diện (1 Registry + 3 Peer đồng thời, ngắt kết nối, gửi bù)
npx tsx tests/test-m5-full-scenario.ts
```

---

## 📂 TÀI LIỆU DÀNH CHO THÀNH VIÊN LÀM BẢO MẬT (GIAI ĐOẠN 2)
Xem chi tiết tại: [Tài liệu Bàn giao Bảo mật (SECURITY_HANDOVER.md)](docs/SECURITY_HANDOVER.md)

