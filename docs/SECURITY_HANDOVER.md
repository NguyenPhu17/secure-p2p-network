# TÀI LIỆU BÀN GIAO BẢO MẬT (SECURITY HANDOVER - GIAI ĐOẠN 2)
### Đề tài: Hệ thống Chat/Chia sẻ File P2P Bảo mật với KDC (Trung tâm Phân phối Khóa)
*Môn học: Các hệ thống phân tán (Nội dung Chương 9: An ninh hệ thống phân tán)*

---

## 1. TỔNG QUAN KIẾN TRÚC GIAI ĐOẠN 1

Hệ thống Giai đoạn 1 đã hoàn thiện toàn bộ **Cốt lõi Phân tán** và **Giao diện Người dùng**:
1. **Registry Node (Mock KDC)**:
   - Quản lý định danh các Peer, danh sách trực tuyến, kiểm tra heartbeat định kỳ và phát hiện peer rớt mạng (TCP Port mặc định: `7000`).
   - Đã chừa sẵn các Stub bảo mật: `requestSessionKey(A, B)` và `verifyIdentity(peer)`.
2. **Peer Backend (Node.js)**:
   - Mở TCP Server trực tiếp để trao đổi gói tin P2P với peer khác (Chat 1-1, truyền File theo chunk 64KB, gửi ACK xác nhận).
   - Mỗi Peer sở hữu một Database SQLite độc lập (`data/<displayName>.db`), sử dụng WAL mode và cache tối ưu RAM.
   - Hỗ trợ chống trùng lặp tin nhắn (`message_id` UUID) và hàng đợi tin nhắn offline (tin lưu `pending`, tự động gửi lại khi đối phương online).
   - Cung cấp WebSocket server nội bộ (`ws://127.0.0.1:<uiPort>`) phục vụ React UI.
3. **React UI (Vite + Tailwind CSS)**:
   - Giao diện sạch, sáng, trung tính, không gradient/shadow nặng.
   - 3 vùng: Cột trái (danh sách peer online/offline), Khung giữa (chat, thanh tiến độ chunk file, xóa lịch sử), Panel phải (xem log chi tiết từng gói tin TCP để đối chiếu với Wireshark).
   - Thanh trạng thái hiển thị nhãn: `Kênh: Chưa mã hóa (Plaintext)`.
4. **Trạng thái truyền tin hiện tại**:
   - Toàn bộ dữ liệu chat và file chunk ở Giai đoạn 1 được truyền dạng **Plaintext** (có chủ đích) để phục vụ việc bắt gói tin Wireshark chứng minh lỗ hổng trước khi áp dụng giải pháp bảo mật ở Giai đoạn 2.

---

## 2. DANH MỤC CÁC VỊ TRÍ ĐÃ CẮM SẴN `TODO(SECURITY)`

Người phụ trách bảo mật có thể tìm kiếm từ khóa `TODO(SECURITY)` trong toàn bộ mã nguồn:

| STT | File | Vị trí / Đối tượng | Mô tả công việc cần làm ở Giai đoạn 2 |
|---|---|---|---|
| 1 | `common/protocol.ts` | Interface `BaseMessage` | Sử dụng 2 trường đã chừa sẵn:<br>• `nonce: string`: Nonce ngẫu nhiên dùng 1 lần chống Replay Attack.<br>• `mac_or_signature: string`: Chữ ký số (RSA/ECDSA) hoặc HMAC chống giả mạo gói tin. |
| 2 | `registry/security-stubs.ts` | `RegistrySecurityStubs` | Cài đặt logic KDC thực thụ:<br>• `requestSessionKey(A, B)`: Cấp Session Key $K_{AB}$ và Ticket $E_{K_B}(A, K_{AB})$ theo giao thức Needham-Schroeder / Kerberos.<br>• `verifyIdentity(peer, proof)`: Xác thực danh tính peer qua chữ ký số. |
| 3 | `peer/channel/plain-channel.ts` & `secure-channel.ts` | Interface `IChannel` | Tạo `SecureChannel implements IChannel` để thay thế `PlainChannel` trong `PeerController`. Toàn bộ mã hóa, bắt tay phiên, giải mã sẽ diễn ra bên trong lớp này. |
| 4 | `peer/db/message-store.ts` | `saveMessage()` / `getHistory()` | • Mã hóa dữ liệu lưu trữ (Encryption at-rest) cho nội dung tin nhắn (`body`).<br>• Lưu và kiểm tra trường `nonce` và `mac_or_signature` trong bảng `messages` để đảm bảo tính toàn vẹn dữ liệu đã lưu. |
| 5 | `common/checksum.ts` | `calculateFileChecksum()` / `calculateChecksum()` | Thay thế hàm băm đơn giản DJB2 bằng `crypto.createHash('sha256')` chuẩn mật mã và tích hợp chữ ký số cho từng chunk và file hoàn chỉnh. |
| 6 | `peer/transfer/file-sender.ts` & `file-receiver.ts` | Truyền file chunk | Mã hóa từng chunk 64KB bằng Session Key trước khi gửi; giải mã và kiểm tra tính toàn vẹn ở bên nhận trước khi ghi xuống đĩa. |

---

## 3. HƯỚNG DẪN THAY THẾ `PlainChannel` BẰNG `SecureChannel`

Kiến trúc đã được thiết kế theo nguyên lý **Dependency Inversion** (phụ thuộc vào abstraction `IChannel`). Khi cài đặt bảo mật, bạn **không cần sửa đổi bất kỳ logic giao diện React hay logic chat nghiệp vụ nào**.

### Bước 1: Hoàn thiện `peer/channel/secure-channel.ts`
Khai báo triển khai `IChannel`:
```typescript
import crypto from "node:crypto";
import { IChannel, MessageHandler } from "../../common/channel.js";
import { BaseMessage } from "../../common/protocol.js";

export class SecureChannel implements IChannel {
  // 1. Quản lý bảng Session Keys giữa ta và các Peer khác: Map<peerName, sessionKeyBuffer>
  private sessionKeys: Map<string, Buffer> = new Map();
  // 2. Cache các Nonce đã nhận trong vòng 5 phút để chống Replay Attack
  private receivedNonces: Set<string> = new Set();

  public async sendMessage(targetIp: string, targetPort: number, message: BaseMessage): Promise<boolean> {
    // 1. Nếu chưa có Session Key với target:
    //    Gọi KDC (Registry) xin Ticket và thực hiện Handshake 3 bước (Needham-Schroeder)
    // 2. Sinh nonce ngẫu nhiên: message.nonce = crypto.randomBytes(16).toString('hex');
    // 3. Mã hóa payload: Dùng AES-256-GCM với Session Key
    // 4. Ký gói tin: message.mac_or_signature = hmac / digital signature
    // 5. Gửi frame qua TCP Socket thô
  }

  public onReceive(handler: MessageHandler): void {
    // 1. Nhận gói tin TCP
    // 2. Kiểm tra Replay Attack: Nếu receivedNonces.has(msg.nonce) -> Drop và ghi log cảnh báo
    // 3. Xác thực MAC / Chữ ký số: Nếu sai -> Drop
    // 4. Giải mã payload bằng Session Key
    // 5. Chuyển payload đã giải mã cho handler(msg)
  }

  public isSecure(): boolean {
    return true; // Báo hiệu cho UI hiển thị "Kênh: Đã mã hóa AES-256-GCM"
  }
}
```

### Bước 2: Chuyển đổi trong `peer/peer-controller.ts`
Trong file `peer/peer-controller.ts`, chỉ cần thay đổi dòng khởi tạo:
```typescript
// Giai đoạn 1 (Cũ):
// this.channel = new PlainChannel(this.ip, this.tcpPort, this.logger);

// Giai đoạn 2 (Mới):
this.channel = new SecureChannel(this.ip, this.tcpPort, this.logger);
```

---

## 4. HƯỚNG DẪN CHẠY DEMO HỆ THỐNG

### 4.1. Cài đặt môi trường
- Yêu cầu: **Node.js v20+** (đã test hoàn hảo trên Node.js v24).
- Cài đặt thư viện:
```bash
npm install
cd ui && npm install && cd ..
```

### 4.2. Chạy trên cùng một máy (Localhost Multi-node)
Mở các cửa sổ Terminal riêng biệt:

**Terminal 1: Khởi động Registry (Mock KDC)**
```bash
npm run registry
# Lắng nghe tại TCP port 7000
```

**Terminal 2: Khởi động Peer 1 (Alice)**
```bash
npx tsx peer/index.ts --name Alice --tcpPort 8001 --uiPort 3001
```

**Terminal 3: Khởi động Peer 2 (Bob)**
```bash
npx tsx peer/index.ts --name Bob --tcpPort 8002 --uiPort 3002
```

**Terminal 4: Khởi động Peer 3 (Charlie)**
```bash
npx tsx peer/index.ts --name Charlie --tcpPort 8003 --uiPort 3003
```

**Terminal 5: Khởi động React UI**
```bash
cd ui
npm run dev
# Mở trình duyệt tại: http://localhost:5173
```
- Mở 3 tab trình duyệt:
  - Tab 1: `http://localhost:5173/?port=3001` (Giao diện của Alice)
  - Tab 2: `http://localhost:5173/?port=3002` (Giao diện của Bob)
  - Tab 3: `http://localhost:5173/?port=3003` (Giao diện của Charlie)

### 4.3. Chạy qua mạng LAN (Nhiều máy tính trong cùng Wi-Fi)
- Xác định địa chỉ IP LAN của máy chạy Registry (ví dụ: `192.168.1.50`).
- Máy Peer khởi chạy với tham số:
```bash
npx tsx peer/index.ts --name Alice --tcpPort 8001 --uiPort 3001 --registryHost 192.168.1.50 --registryPort 7000
```

---

## 5. HƯỚNG DẪN BẮT GÓI TIN WIRESHARK MINH CHỨNG (DEMO GIẢNG VIÊN)

Để minh chứng hiệu quả của việc cài đặt bảo mật ở Giai đoạn 2 so với Giai đoạn 1:

1. **Khởi động Wireshark**:
   - Chọn card mạng `Adapter for loopback traffic capture` (nếu test trên cùng máy) hoặc card Wi-Fi/Ethernet (nếu test qua LAN).
2. **Bộ lọc hiển thị (Display Filter)**:
   ```wireshark
   tcp.port == 8001 || tcp.port == 8002 || tcp.port == 7000
   ```
3. **Thực hiện gửi tin nhắn chat hoặc file**:
   - Nhấn chuột phải vào một gói tin TCP P2P -> Chọn **Follow** -> **TCP Stream**.
4. **Kết quả đối chứng**:
   - **Giai đoạn 1 (Hiện tại)**: Giảng viên sẽ nhìn thấy rõ ràng toàn bộ nội dung JSON plaintext:
     `{"type":"CHAT","sender":"Alice","receiver":"Bob","payload":{"body":"Noi dung mat"}}`.
   - **Giai đoạn 2 (Sau khi cài SecureChannel)**: Toàn bộ nội dung sẽ là chuỗi byte mã hóa ngẫu nhiên (Ciphertext) kèm Nonce và Auth Tag, không thể đọc trộm hay sửa đổi.

