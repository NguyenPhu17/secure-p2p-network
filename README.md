# Thiết kế và Hiện thực Mạng Phân tán P2P Dựa trên Kademlia DHT và Định tuyến Mesh Relay Kết hợp Bảo mật E2EE Phi Tập Trung (Zero SPOF)
## Đề tài môn học: Các hệ thống phân tán (Distributed Systems)

Dự án nghiên cứu, thiết kế và triển khai kiến trúc mạng phân tán Peer-to-Peer (P2P) kết hợp bảng băm phân tán Kademlia DHT (Zero SPOF), cơ chế định tuyến đa chặng Mesh Relay và giải pháp bảo mật mã hóa đầu cuối E2EE phi tập trung (Zero SPOF) dựa trên trao đổi khóa Diffie-Hellman (ECDH / X25519) và chữ ký số Ed25519. Ứng dụng thực nghiệm: Hệ thống chat thời gian thực và chia sẻ tập tin phân tán.

---

## 📌 PHẠM VI & KIẾN TRÚC HỆ THỐNG
- **Kiến trúc Phi tập trung hoàn toàn (Pure P2P DHT - Zero SPOF)**:
  - Hệ thống sử dụng bảng băm phân tán **Kademlia DHT** để các peer tự khám phá lẫn nhau mà **không cần bất kỳ Registry trung tâm nào**.
  - Không gian định danh 160-bit SHA-1, khoảng cách metric XOR \(d(x, y) = x \oplus y\), 160 K-Buckets kết hợp thuật toán trục xuất LRU.
  - **Chuẩn hóa định danh mật mã học (Identity Consensus & Anti Name-Collision)**:
    - Node ID được sinh từ **`SHA1(PublicKey)`** (cặp khóa Ed25519) thay vì `SHA1(displayName)`.
    - Khi có nhiều node cùng đặt tên `--name Alice`, mỗi node vẫn sở hữu một Node ID 160-bit duy nhất; bảng K-bucket của các peer khác (như Bob) không bị ghi đè loạn xạ.
    - Phát hiện xung đột tên trên DHT (`[NAME COLLISION]`) và bảo vệ quyền sở hữu định danh.
  - **Hàn gắn phân mảnh mạng (Network Partition Healing)**:
    - Cơ chế định kỳ tự động dò quét và tái kích hoạt bootstrap tới các bootstrap / known peers đã bị rớt kết nối hoặc bị xóa khỏi K-bucket khi mạng bị chia cắt thành 2 nửa cô lập (Partition).
    - Khi đường truyền vật lý phục hồi, hai nửa mạng **tự động kết nối lại và hợp nhất K-bucket mà không cần khởi động lại bất kỳ node nào**.
  - Các hàm RPC giao thức: `DHT_PING`, `DHT_PONG`, `DHT_FIND_NODE`, `DHT_FIND_NODE_RESP`, `DHT_STORE`, `DHT_FIND_VALUE`.
  - Cơ chế giám sát sống/chết (Liveness Check) phi tập trung thông qua chu kỳ DHT Ping định kỳ giữa các peer, loại bỏ hoàn toàn Single Point of Failure (SPOF).
- **Bảo mật E2EE Phi Tập Trung (Decentralized E2EE - Loại bỏ hoàn toàn KDC)**:
  - **Mâu thuẫn kiến trúc KDC**: Mô hình KDC (Key Distribution Center như Kerberos / Needham-Schroeder) là kiến trúc Client-Server tập trung, tạo ra Single Point of Failure (SPOF). Nếu Server KDC sập, hai peer không thể xin khóa phiên để bảo mật, làm vô hiệu hóa thuộc tính Zero SPOF của DHT.
  - **Khắc phục chuẩn phân tán**: Hệ thống sử dụng mô hình **E2EE (End-to-End Encryption) phi tập trung**:
    - Mỗi peer tự sinh và lưu trữ cục bộ cặp khóa **Ed25519** trong SQLite (`node_identity`), định danh mật mã học bằng Node ID = `SHA1(PublicKey)`.
    - Public Key được phát tán trực tiếp qua Kademlia DHT.
    - Hai peer trao đổi khóa phiên trực tiếp bằng giao thức **Diffie-Hellman trên đường cong Elliptic (ECDH / X25519)** và xác thực bằng chữ ký Ed25519 chống Man-in-the-Middle (MITM), hoàn toàn không phụ thuộc bất kỳ máy chủ KDC trung gian nào.
- **Định tuyến Đa chặng Mesh Relay (Multi-hop Overlay Routing)**:
  - Khi đường truyền trực tiếp giữa Alice và Bob bị lỗi (khác mạng LAN, sau tường lửa/NAT, hoặc rớt mạng cục bộ), hệ thống **tự động kích hoạt cơ chế Mesh Relay** mượn một Peer thứ 3 (như Charlie) chuyển tiếp gói tin.
  - Đóng gói phong bì `RELAY_FORWARD`, lưu vết tuyến đường `route: ["Alice", "Charlie", "Bob"]`, chống lặp vòng định tuyến (Routing Loop Prevention), giới hạn chặng TTL (`hopCount < maxHops`), và bộ nhớ đệm đảo chiều (Reverse Path Caching) cho phản hồi ACK 2 chiều.
- **Thứ tự sự kiện và Tính nhân quả (Logical Clocks & Causality - Leslie Lamport 1978)**:
  - **Khắc phục triệt để Clock Drift / Clock Skew**: Giải quyết tiên đề cốt lõi của hệ phân tán (Leslie Lamport 1978: *"Không tồn tại đồng hồ vật lý toàn cục đồng bộ tuyệt đối"*).
  - **Đồng hồ logic Lamport & Vector Clocks**:
    - Mỗi gói tin `BaseMessage` đều mang trường `lamport_clock` (Scalar Lamport Clock) và `vector_clock` (Vector Clocks map).
    - Cập nhật đồng hồ theo 2 quy tắc Lamport: Gửi/nội bộ: $L = L + 1$; Nhận: $L_{rec} = \max(L_{rec}, L_{msg}) + 1$.
    - **Lamport Total Order**: Sắp xếp lịch sử tin nhắn tại SQLite và UI theo thứ tự toàn phần $(L, \text{sender}, \text{seq}, \text{timestamp})$. Dù đồng hồ máy Bob bị lệch lùi 1 giờ so với Alice hoặc gói tin bị trễ qua nhiều chặng Mesh Relay, **câu hỏi của Alice ($L=1$) luôn luôn hiển thị trước câu trả lời của Bob ($L=4$)**.
    - **Phân giải xung đột DHT (Conflict Resolution)**: Khi ghi đè key-value trên DHT, node so sánh `lamport_clock` thay vì `Date.now()`, kiên quyết từ chối ghi đè dữ liệu mới hơn bằng dữ liệu cũ bị trễ mạng.
    - **Bền vững & Đơn điệu (Monotonicity Across Restarts)**: Lưu trữ trạng thái đồng hồ logic vào bảng `node_state` trong SQLite, đảm bảo sau khi restart node, đồng hồ không bao giờ bị thụt lùi.
    - **Trực quan hóa UI**: Hiển thị badge `L:<number>` ngay trên bong bóng chat của từng tin nhắn.
- **Phần truyền nhận TCP P2P Direct**:
  - Peer Backend mở kết nối TCP Socket thô trực tiếp giữa các Peer, cơ chế Framing 4-bytes Length-prefixed chống vỡ/dính gói tin, chia nhỏ file thành chunk 64KB, hàng đợi tin nhắn offline, chống trùng tin nhắn qua UUID (`message_id`).
- **Lưu trữ cục bộ**: Mỗi Peer sở hữu database SQLite độc lập (`better-sqlite3` / `node:sqlite`), tối ưu hóa RAM với WAL mode và giới hạn cache 2MB.
- **Giao diện**: React + Vite + Tailwind CSS với bố cục 3 vùng (Sidebar hiển thị Node ID và danh sách peer, Khung chat & tiến độ file, Panel xem Protocol Logs trực tiếp có tab lọc DHT).
- **Trạng thái bảo mật**: Truyền **Plaintext** (có chủ đích) phục vụ bắt gói tin Wireshark so sánh trước/sau khi kích hoạt mã hóa E2EE ở Giai đoạn 2.

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

## 💻 CÁCH 2: CHẠY THỦ CÔNG TRÊN TERMINAL (KHÔNG CẦN REGISTRY)

### Khởi động các Peer Backend (Pure P2P DHT):
Mở các cửa sổ Terminal riêng:

```bash
# Terminal Peer 1 (Alice - Seed Node khởi nguồn, tự trị không cần Registry):
npx tsx peer/index.ts --name Alice --tcpPort 8001 --uiPort 3001 --mode dht

# Terminal Peer 2 (Bob - Gia nhập mạng bootstrap qua Alice):
npx tsx peer/index.ts --name Bob --tcpPort 8002 --uiPort 3002 --mode dht --bootstrap 127.0.0.1:8001

# Terminal Peer 3 (Charlie - Gia nhập mạng CHỈ qua Bob, tự động tìm thấy Alice qua DHT):
npx tsx peer/index.ts --name Charlie --tcpPort 8003 --uiPort 3003 --mode dht --bootstrap 127.0.0.1:8002
```

*(Lưu ý: Hệ thống vẫn hỗ trợ chế độ `--mode registry` truyền thống nếu bạn muốn chạy cùng Registry Server tập trung `npm run registry`)*.

### Khởi động React UI
```bash
cd ui
npm run dev
```
Mở trình duyệt:
- Tab 1: `http://localhost:5173/?port=3001` (Giao diện của Alice)
- Tab 2: `http://localhost:5173/?port=3002` (Giao diện của Bob)
- Tab 3: `http://localhost:5173/?port=3003` (Giao diện của Charlie)

---

## 🧪 BỘ KIỂM THỬ TỰ ĐỘNG (AUTOMATED TEST SUITES)

Dự án cung cấp bộ kịch bản kiểm thử toàn diện cho các tiên đề và giải thuật của Hệ thống Phân tán:

```bash
# 1. Kiểm thử Tính nhân quả & Đồng hồ Logic (Lamport Logical Clocks & Vector Clocks, Clock Skew immunity):
npm run test:causality

# 2. Kiểm thử Định tuyến đa chặng Mesh Relay (Multi-hop Overlay, TTL, Loop Prevention):
npm run test:mesh

# 3. Kiểm thử Bền vững dữ liệu DHT & Distributed Mailbox offline:
npm run test:persistence

# 4. Kiểm thử Xung đột định danh & Tự động hàn gắn phân mảnh mạng (Network Partition Healing):
npm run test:healing

# 5. Kiểm thử đơn vị thuật toán Kademlia DHT (XOR metric, K-buckets, LRU Eviction):
npm run test:dht:unit
```


