# KẾ HOẠCH TRIỂN KHAI: THIẾT KẾ VÀ HIỆN THỰC MẠNG PHÂN TÁN P2P DỰA TRÊN KADEMLIA DHT VÀ ĐỊNH TUYẾN MESH RELAY KẾT HỢP BẢO MẬT E2EE PHI TẬP TRUNG (ZERO SPOF)
### Ứng dụng thực nghiệm: Chat thời gian thực & Truyền tập tin P2P (Distributed Core + React UI)

---

## 1. GIẢ ĐỊNH & THIẾT KẾ CƠ BẢN

1. **Môi trường & Ngôn ngữ**:
   - Backend sử dụng **Node.js (TypeScript, ESM)** cho cả Registry và Peer Backend để dùng chung Type Definitions (`common/protocol.ts`) giữa Backend và Frontend, giảm thiểu lỗi format message.
   - Frontend sử dụng **React + Vite + Tailwind CSS + TypeScript**.
   - Cơ sở dữ liệu: **SQLite** thông qua thư viện native `better-sqlite3` (nhẹ, nhanh, đồng bộ, hoàn hảo cho node P2P cục bộ).
2. **Cơ chế truyền nhận qua TCP Socket thô (Framing)**:
   - Dùng **Length-prefixed framing** (4 bytes `Int32BE` quy định độ dài payload + JSON UTF-8 payload). Cơ chế này tối ưu cho việc truyền file chunk và tin nhắn dài, tránh rủi ro vỡ/dính gói tin TCP stream.
3. **Mô hình định danh Peer & Mạng**:
   - Một Peer định danh duy nhất bởi `displayName` (chuỗi ký tự). Khi chạy trên cùng máy, mỗi peer bind một cổng TCP riêng (ví dụ 8001, 8002...) và một cổng WebSocket riêng cho UI (ví dụ 3001, 3002...).
   - Registry chạy trên cổng cố định (mặc định TCP `7000`, chỉ đóng vai trò Discovery / Bootstrap Node tùy chọn trong chế độ Legacy).
4. **Trách nhiệm bảo mật**:
   - Giai đoạn 1 toàn bộ gói tin truyền dạng **Plaintext** (để dễ dàng inspect Wireshark minh chứng trước/sau khi áp dụng E2EE & crypto ở Giai đoạn 2).
   - Thiết kế cắm sẵn interface `Channel` và `MessageStore` có đầy đủ các trường `nonce`, `mac_or_signature`, và comment `TODO(SECURITY)`.
   - **Loại bỏ KDC (Zero SPOF)**: Thay thế mô hình KDC tập trung bằng mô hình End-to-End Encryption (E2EE) phi tập trung: mỗi peer tự sinh cặp khóa Ed25519, tính Node ID = `SHA1(PublicKey)`, và trao đổi khóa phiên trực tiếp bằng Diffie-Hellman (ECDH / X25519) mà không cần bất kỳ máy chủ KDC nào.
5. **Giao tiếp UI - Backend**:
   - Dùng duy nhất **WebSocket hai chiều** trên Localhost (`ws://127.0.0.1:<PORT>`) để gửi lệnh và nhận sự kiện real-time.
6. **Thư mục tải file**:
   - Mỗi peer lưu file nhận được vào `downloads/<displayName>/` để tránh xung đột khi chạy nhiều peer trên 1 máy.

---

## 2. CHIẾN LƯỢC TỐI ƯU HÓA BỘ NHỚ RAM (RAM OPTIMIZATION)

Nhằm đảm bảo hệ thống có thể chạy đồng thời 3 hoặc nhiều peer trên cùng một máy cấu hình phổ thông mà không bị tràn RAM (Out-Of-Memory) hay giật lag:

1. **Truyền File dạng Stream nhị phân (Zero-Whole-File Buffering)**:
   - Khi gửi file lớn (10MB - 50MB+), Backend **tuyệt đối không đọc toàn bộ file vào RAM**. Thay vào đó, dùng `fs.openSync` / `fs.read` để đọc từng chunk đúng kích thước `64 KB` vào một Buffer đệm nhỏ, đóng gói frame TCP và gửi đi ngay. Sau khi gửi, Buffer được GC thu hồi hoặc tái sử dụng.
   - Bên nhận: Nhận chunk nào thì ghi trực tiếp chunk đó xuống đĩa qua `fs.writeSync` hoặc `WriteStream`, không tích lũy các chunk trong mảng RAM.
2. **Quản lý Bộ đệm TCP Socket Framing không rò rỉ (Zero-Copy / Clean Buffer Slice)**:
   - Khi nhận dữ liệu từ TCP stream (sự kiện `data`), hệ thống sử dụng thuật toán gom buffer thông minh: chỉ tích lũy phần chưa đủ độ dài gói tin, khi bóc tách xong frame thì giải phóng ngay phần buffer cũ (`Buffer.copy` hoặc giữ con trỏ offset thay vì `Buffer.concat` liên tục tạo rác bộ nhớ).
3. **Tối ưu hóa SQLite (better-sqlite3 Cache & WAL Mode)**:
   - Kích hoạt chế độ WAL (`PRAGMA journal_mode = WAL;`) để đọc/ghi song song không lock.
   - Giới hạn cache bộ nhớ của SQLite ở mức tiết kiệm: `PRAGMA cache_size = -2000;` (khoảng ~2MB RAM cho mỗi peer database).
   - Truy vấn lịch sử tin nhắn luôn có `LIMIT 50` kết hợp `OFFSET` / `beforeTimestamp` và tận dụng Index `(conversation_id, timestamp DESC, seq DESC)` để không quét toàn bảng vào RAM.
4. **Giới hạn bộ đệm Log trong bộ nhớ (Bounded Protocol Logs Buffer)**:
   - Protocol Logs đẩy lên UI hoặc lưu trong RAM Peer Backend chỉ giữ tối đa `100` log gần nhất dạng ring buffer (FIFO queue). Log đầy đủ chi tiết sẽ được ghi stream nối tiếp ra file `logs/<displayName>.log` trên đĩa.
5. **Tách biệt dữ liệu File trên WebSocket**:
   - File nhị phân truyền trực tiếp qua TCP Socket giữa các Peer Backend.
   - Cầu nối WebSocket lên React UI **không truyền payload nhị phân của file**, mà chỉ truyền tiến độ dạng số nguyên (`progress: 45%`, `speed`, `chunk: 12/50`), giữ cho React UI thread luôn nhẹ và không bị lag.

---

## 3. KIẾN TRÚC HỆ THỐNG & SƠ ĐỒ LUỒNG DỮ LIỆU

### 3.1. Sơ đồ kiến trúc tổng thể hệ thống (System Architecture & Layered Models)

#### 3.1.1. Sơ đồ kiến trúc mạng phân tán P2P Overlay & Các kênh truyền thông
```text
                             ┌───────────────────────────────────┬───────────────────────────────────┐
                             │       REGISTRY NODE (OPTIONAL BOOTSTRAP / FALLBACK DISCOVERY ONLY)    │
                             │ - TCP Service Port: 7000 (Centralized Discovery Tùy chọn / Legacy)    │
                             │ - Quản lý trạng thái Peer (Online/Offline) • Heartbeat (5s / 15s)     │
                             │ - HOÀN TOÀN KHÔNG CÓ KDC: Không lưu khóa, không phân phối session key │
                             └───────────────────────────────────┴───────────────────────────────────┘
                                                                 │
                    ┌────────────────────────────────────────────┼────────────────────────────────────────────┐
                    │ (Optional Discovery)                       │ (Optional Discovery)                       │ (Optional Discovery)
                    ▼                                            ▼                                            ▼
┌───────────────────┬───────────────────┐    ┌───────────────────┬───────────────────┐    ┌───────────────────┬───────────────────┐
│ PEER ALICE (CLIENT NODE)              │    │ PEER CHARLIE (ROUTER & RELAY NODE)    │    │ PEER BOB (CLIENT NODE)                │
│ - Vai trò: Client P2P gửi & nhận tin  │    │ - Vai trò: Nút trung gian định tuyến  │    │ - Vai trò: Client P2P gửi & nhận tin  │
│ - Cổng TCP: 8001 | Cổng WS: 3001      │    │ - Cổng TCP: 8003 | Cổng WS: 3003      │    │ - Cổng TCP: 8002 | Cổng WS: 3002      │
│ - Web UI: React Dashboard (Port 5173) │    │ - Web UI: Relay Monitor (Port 5173)   │    │ - Web UI: React Dashboard (Port 5173) │
│ - UIBridge: WebSocket Event Stream    │    │ - UIBridge: WebSocket Event Stream    │    │ - UIBridge: WebSocket Event Stream    │
│ - Controller: State & Offline Queue   │    │ - Router: Loop Check (TTL) & Cache    │    │ - Controller: State & Offline Queue   │
│ - Kademlia DHT: 160 K-Buckets         │    │ - Kademlia DHT: 160 K-Buckets         │    │ - Kademlia DHT: 160 K-Buckets         │
│ - FileTransfer: Zero-RAM Stream 64KB  │    │ - Relay Forwarder: Multi-hop Engine   │    │ - FileTransfer: Zero-RAM Stream 64KB  │
│ - SQLite Store: WAL (≤ 2MB Cache)     │    │ - SQLite Store: WAL (≤ 2MB Cache)     │    │ - SQLite Store: WAL (≤ 2MB Cache)     │
│ - TCP Transport: 4B Length-Prefixed   │    │ - TCP Transport: 4B Length-Prefixed   │    │ - TCP Transport: 4B Length-Prefixed   │
└───────────────────┴───────────────────┘    └───────────────────┴───────────────────┘    └───────────────────┴───────────────────┘
                    │ (Direct TCP Data)                          │ (Relay Bypass)                             │ (Direct TCP Data)
                    ▼                                            │                                            ▼
┌───────────────────┴────────────────────────────────────────────┼────────────────────────────────────────────┴───────────────────┐
│ KÊNH 1: TRUYỀN THÔNG TRỰC TIẾP (DIRECT P2P TCP CHANNEL)                                                                         │
│ - Kết nối TCP Socket thô 1-1: Alice (Port 8001) ◄══════════════╪═════════════════════════► Bob (Port 8002)                      │
│ - Cơ chế Framing: 4-Byte Length-Prefixed (Int32BE) + Payload UTF-8 JSON / Stream nhị phân Zero-Copy                             │
│ - Luồng dữ liệu: CHAT (tin nhắn 1-1), FILE_META & FILE_CHUNK (Stream 64KB Zero-RAM), CHAT_ACK, FILE_ACK                         │
└───────────────────┬────────────────────────────────────────────┼────────────────────────────────────────────┬───────────────────┘
                    │ (Mesh Fallback)                            │ (Relay Forward)                            │ (Mesh Fallback)
                    ▼                                            ▼                                            ▼
┌───────────────────┬────────────────────────────────────────────┬────────────────────────────────────────────┬───────────────────┐
│ KÊNH 2: ĐỊNH TUYẾN MESH RELAY & KADEMLIA DHT (OVERLAY MESH & FALLBACK ROUTING)                                                  │
│ - Định tuyến đa chặng: Alice (8001) ◄─── Hop 1 ───► Charlie (Router: 8003) ◄─── Hop 2 ───► Bob (8002)                           │
│ - Cơ chế Mesh Relay: Gói tin RELAY_FORWARD, RELAY_ACK, kiểm tra Loop Detection, TTL, Reverse Path Cache                         │
│ - Khám phá phân tán Kademlia DHT: 160 K-Buckets, Node ID SHA1(Ed25519), DHT_PING, DHT_FIND_NODE, Auto-Healing                   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 3.1.2. Sơ đồ phân tầng kiến trúc nội bộ một Peer Node (Peer Internal Layered Stack)
```text
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│ TẦNG 1: GIAO DIỆN NGƯỜI DÙNG (PRESENTATION LAYER - REACT WEB UI)                                  │
│ - Công nghệ: React 18, Vite, Tailwind CSS, TypeScript (Port 5173)                                 │
│ - Chức năng: Dashboard điều khiển, danh sách Peer Online/Offline, phòng chat 1-1                  │
│ - Tiến độ file: Hiển thị thanh tiến trình trực quan (% progress, tốc độ MB/s)                     │
│ - Panel Protocol Logs: Xem gói tin giao thức trực tiếp (Type, Sender, Seq, Len) để demo           │
└─────────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                  │▲ WebSocket 2 chiều (JSON Commands & Events)
                                                  ▼│ Zero Binary Buffering (Chỉ truyền % tiến độ file)
┌─────────────────────────────────────────────────┴─────────────────────────────────────────────────┐
│ TẦNG 2: CẦU NỐI ĐIỀU KHIỂN & SỰ KIỆN (UIBRIDGE & EVENT STREAM)                                    │
│ - Công nghệ: WebSocket Server hai chiều (ws://127.0.0.1:<wsPort>)                                 │
│ - Giao tiếp UI: Đẩy sự kiện realtime (tin nhắn đến, peer online/offline, tiến độ file)            │
│ - Bounded Protocol Logs Buffer: Ring buffer FIFO giữ tối đa 100 log gần nhất trong RAM            │
│ - Tối ưu hóa UI: Không đẩy payload nhị phân file lên WebSocket để tránh đơ giao diện              │
└─────────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                  │▲ Node.js EventEmitter (Internal EventBus)
                                                  ▼│ Dispatch hành động UI xuống Controller & Core Services
┌─────────────────────────────────────────────────┴─────────────────────────────────────────────────┐
│ TẦNG 3: ĐIỀU PHỐI & ĐỊNH TUYẾN MẠNG (PEER CONTROLLER & ROUTER ENGINE)                             │
│ - PeerController: Quản trị vòng đời node, presence, xử lý sự kiện từ EventBus                     │
│ - Offline Message Queue: Lưu tạm tin nhắn pending vào SQLite khi Peer đích vắng mặt               │
│ - Router Engine: Tự động chọn kênh truyền (Ưu tiên Direct P2P TCP -> Fallback Mesh Relay)         │
│ - Loop Detection: Kiểm tra Route Path và giới hạn TTL hopCount tránh lặp vòng lặp vô tận          │
│ - Reverse Path Routing Cache: Ghi nhớ chặng ngược để forward phản hồi RELAY_ACK về nguồn          │
└─────────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                  │▲ API Calls & Data Buffers (Stream 64KB)
                                                  ▼│ Gọi hàm lưu SQLite WAL, DHT Routing, File Streaming
┌─────────────────────────────────────────────────┴─────────────────────────────────────────────────┐
│ TẦNG 4: DỊCH VỤ CỐT LÕI & LƯU TRỮ (CORE SERVICES & STORAGE LAYER)                                 │
│ - Kademlia DHT: 160 K-Buckets, Node ID SHA1(Ed25519), DHT_PING/FIND_NODE, Partition Healing       │
│ - FileTransfer Engine: Zero-RAM Streaming, cắt khối 64KB Buffer, kiểm tra SHA256 toàn vẹn         │
│ - SQLite Local Store: Chế độ WAL, cache_size = -2000 (≤ 2MB RAM), đánh index (conv_id, time)      │
│ - Security Extension (Phase 2): Cắm sẵn interface Nonce, E2EE (ECDH/X25519 & Ed25519), HMAC / Signature │
└─────────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                  │▲ Structured Protocol Messages & Chunks
                                                  ▼│ Đóng gói / Bóc tách 4-Byte Length-Prefixed Frame
┌─────────────────────────────────────────────────┴─────────────────────────────────────────────────┐
│ TẦNG 5: VẬN CHUYỂN GÓI TIN TCP (TCP TRANSPORT & FRAMING ENGINE)                                   │
│ - Raw TCP Socket Manager: Quản lý pool kết nối TCP giữa các Peer Backend (Ports 8001, 8002...)    │
│ - Framing Protocol: [4 Bytes Length UInt32BE] + [JSON String UTF-8 / Raw Chunk Buffer]            │
│ - Quản lý bộ đệm không rò rỉ: Stream bóc tách frame bằng offset pointer, không concat rác RAM     │
└─────────────────────────────────────────────────┬─────────────────────────────────────────────────┘
                                                  │▲ Raw TCP Socket Streams
                                                  ▼│ (Plaintext TCP / Phase 2 E2EE Encrypted)
┌─────────────────────────────────────────────────┴─────────────────────────────────────────────────┐
│ MẠNG VẬT LÝ & KÊNH TRUYỀN P2P (PHYSICAL & OVERLAY NETWORK CHANNELS)                               │
│ - Kênh Registry Centralized (Tùy chọn): TCP Port 7000 (Đăng ký, Heartbeat 5s/15s - Zero Security) │
│ - Kênh Direct P2P: Kết nối TCP 1-1 trực tiếp (CHAT, FILE_CHUNK 64KB, E2EE Handshake, ACK)         │
│ - Kênh Mesh Relay & DHT: Đa chặng qua Charlie (RELAY_FORWARD, RELAY_ACK, DHT Lookup)              │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2. Luồng hoạt động chính
1. **Đăng ký (Chế độ Centralized Registry)**: Peer mở TCP Server -> kết nối tới Registry TCP 7000 gửi `REGISTER { displayName, ip, tcpPort }`. Nếu trùng tên, Registry trả về lỗi `NAME_TAKEN`.
2. **Heartbeat (Chế độ Registry)**: Mỗi 5s, Peer gửi `HEARTBEAT`. Nếu quá 15s không nhận được, Registry đánh dấu offline và broadcast `PEER_LEFT`.
3. **Khám phá phân tán qua Kademlia DHT (Pure P2P - Zero SPOF)**:
   - Node tự sinh cặp khóa Ed25519, tính Node ID duy nhất: `SHA1(PublicKey)`.
   - Kết nối vào mạng qua bootstrap node (`--bootstrap <ip>:<port>`), gửi `DHT_PING` và `DHT_FIND_NODE` để khám phá các nút lân cận và cập nhật 160 K-Buckets.
   - Cơ chế **Network Partition Healing**: Khi mạng bị chia cắt rồi nối lại, các peer tự động tái kích hoạt kết nối tới các bootstrap node đã biết để hàn gắn bảng định tuyến mà không cần khởi động lại.
4. **Chat 1-1 (Direct P2P)**:
   - Alice gửi tin cho Bob -> Lưu SQLite trạng thái `pending`.
   - Mở kết nối TCP trực tiếp Alice -> Bob gửi message `CHAT`. Chuyển trạng thái `sent`.
   - Bob nhận -> Kiểm tra `message_id` chống trùng -> Lưu SQLite Bob -> Phản hồi `CHAT_ACK`.
   - Alice nhận `CHAT_ACK` -> Cập nhật trạng thái `delivered` và báo lên UI qua WebSocket.
5. **Định tuyến Đa chặng Mesh Relay (Multi-hop Overlay Fallback)**:
   - Khi Alice không thể kết nối trực tiếp đến Bob (sau tường lửa, NAT, đứt kết nối vật lý trực tiếp), hệ thống tự kích hoạt chế độ Relay qua nút trung gian (Charlie).
   - Alice gửi `RELAY_FORWARD` kèm lộ trình `route: ["Alice", "Charlie", "Bob"]` và `hopCount = 0`.
   - Charlie nhận, kiểm tra tránh lặp vòng (loop detection) và TTL (`hopCount < maxHops`), lưu bộ đệm đảo chiều (Reverse Path Cache), rồi chuyển tiếp gói tin tới Bob.
   - Bob nhận được tin nhắn và gửi phản hồi `RELAY_ACK` ngược lại cho Alice qua Charlie.
6. **Hàng đợi tin offline**: Nếu Bob offline hoàn toàn, tin nhắn nằm chờ ở SQLite của Alice (`pending`). Khi Bob online trở lại (nhận event từ DHT hoặc Registry), Alice tự động gửi lại các tin `pending`.
7. **Truyền File Phân đoạn (64KB Chunking & Stream Zero-RAM)**:
   - Alice gửi `FILE_META` (tên, kích thước, số chunk, SHA256 tổng). Bob xác nhận và mở file nhận tại `downloads/Bob/`.
   - Alice đọc từng khối `64 KB` bằng stream nhị phân (không đọc cả file vào RAM) -> tính checksum -> gửi `FILE_CHUNK`.
   - Bob nhận từng chunk -> ghi ngay xuống đĩa -> gửi `FILE_ACK`.
   - Hoàn tất: Bob kiểm tra checksum/hash toàn file. Khớp -> thành công; Sai -> báo lỗi.
   - Cầu nối WebSocket chỉ truyền phần trăm tiến độ (`progress %`) lên React UI, không truyền dữ liệu nhị phân để UI không bị giật lag.

---

## 4. ĐẶC TẢ MESSAGE GIAO THỨC (TCP PROTOCOL)

Framing: `[4 Bytes Length UInt32BE] + [JSON String UTF-8]`

### 4.1. Cấu trúc Message chuẩn (`BaseMessage`)
```typescript
interface BaseMessage<T = any> {
  type: MessageType;          // REGISTER, HEARTBEAT, CHAT, FILE_META, FILE_CHUNK, ...
  message_id: string;        // UUIDv4 duy nhất
  sender: string;            // Tên bên gửi
  receiver: string;          // Tên bên nhận ("REGISTRY", "BROADCAST", hoặc displayName)
  seq: number;               // Sequence number tuần tự giữa 2 peer
  timestamp: number;         // Unix timestamp tính bằng milliseconds
  payload: T;                // Dữ liệu chi tiết của message
  // CHỖ CẮM CHO BẢO MẬT (Giai đoạn 1 để null)
  nonce: string | null;            // TODO(SECURITY): Nonce chống tấn công phát lại (Replay attack)
  mac_or_signature: string | null; // TODO(SECURITY): HMAC hoặc RSA/ECDSA Signature
}
```

### 4.2. Danh mục Message Types
- `REGISTER`: Đăng ký peer với registry.
- `REGISTER_ACK`: Phản hồi kết quả đăng ký kèm danh sách peer online.
- `HEARTBEAT`: Duy trì kết nối sống.
- `HEARTBEAT_ACK`: Phản hồi heartbeat.
- `PEER_JOINED`: Registry thông báo peer mới vào mạng.
- `PEER_LEFT`: Registry thông báo peer rời mạng (hoặc timeout).
- `CHAT`: Tin nhắn văn bản giữa 2 peer.
- `CHAT_ACK`: Xác nhận đã nhận tin nhắn.
- `FILE_META`: Thông tin kích thước, số lượng chunk, hash file.
- `FILE_CHUNK`: Dữ liệu 1 chunk 64KB (base64) kèm hash chunk.
- `FILE_ACK`: Xác nhận đã ghi thành công 1 chunk.
- `ERROR`: Thông báo lỗi giao thức.

---

## 5. THIẾT KẾ CƠ SỞ DỮ LIỆU SQLITE (MỖI PEER 1 FILE RIÊNG)

Đường dẫn: `data/<displayName>.db`

### 5.1. Bảng dữ liệu
- `schema_version`: Lưu version schema phục vụ migration.
- `peers`: `(peer_name PK, last_ip, last_port, last_seen)`
- `conversations`: `(id PK, peer_name UNIQUE, created_at, last_message_at)`
- `messages`:
  - `message_id PK TEXT`: UUID chống trùng lặp
  - `conversation_id FK TEXT`: Thuộc cuộc trò chuyện nào
  - `sender TEXT, receiver TEXT, direction TEXT ('in'/'out')`
  - `seq INTEGER, timestamp INTEGER, body TEXT`
  - `status TEXT ('pending', 'sent', 'delivered', 'failed')`
  - `type TEXT ('chat', 'file')`
  - `file_id TEXT NULL`
  - `created_at INTEGER`
  - `nonce TEXT NULL, mac_or_signature TEXT NULL`: *TODO(SECURITY) Lưu kiểm tra toàn vẹn*
- `files`:
  - `file_id PK TEXT, conversation_id FK TEXT, file_name TEXT, size INTEGER, hash TEXT, status TEXT, local_path TEXT, direction TEXT, created_at INTEGER`
- `INDEX idx_messages_conv_time ON messages(conversation_id, timestamp DESC, seq DESC)`

---

## 6. THIẾT KẾ GIAO DIỆN REACT (UI DESIGN)

- Phong cách: **Sạch, sáng, hiện đại, tối giản**.
- Bảng màu: Nền trắng/xám nhạt (`bg-slate-50`), text màu than chì (`text-slate-800`), màu nhấn xanh dương trung tính (`bg-blue-600`), viền mảnh tinh tế (`border-slate-200`).
- Tuyệt đối không dùng gradient, shadow nặng hoặc animation rườm rà.
- Bố cục 3 vùng:
  1. **Cột trái (280px)**: Tên hiển thị người dùng, danh sách peer online (chấm xanh), peer offline (chấm xám), số tin chưa đọc.
  2. **Khu giữa**: Header cuộc chat (tên đối phương + trạng thái kết nối + menu Xóa lịch sử); Khung hiển thị tin nhắn (tin của mình bên phải kèm status pending/sent/delivered, tin đối phương bên trái); Khung gõ tin kèm nút gửi và nút đính kèm file; Tiến độ file dạng thanh tiến trình nhỏ gọn.
  3. **Panel phải (Collapsible)**: Xem log gói tin giao thức trực tiếp (Type, Sender, Receiver, Seq, Length) phục vụ demo và kiểm tra Wireshark.
  4. **Thanh trạng thái dưới đáy**: Hiển thị nhãn `Kênh truyền: Plaintext (Chưa mã hóa) - Chờ Giai đoạn 2 E2EE (Zero SPOF)`.

---

