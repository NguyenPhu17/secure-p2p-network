# Sơ đồ Cơ sở Dữ liệu & ERD Backend (PostgreSQL)

Hệ thống lưu trữ backend được thiết kế theo mô hình **Multi-Tenant** thông qua cột `node_owner`, cho phép nhiều peer node cùng chia sẻ một cụm cơ sở dữ liệu PostgreSQL duy nhất mà vẫn đảm bảo phân tách dữ liệu an toàn.

---

## 1. Vị trí các file liên quan tới Database

- **File kết nối chính**: [peer/db/connection.ts](file:///D:/P2P/secure-p2p-network/peer/db/connection.ts)
  - Khởi tạo và quản lý `pg.Pool` (`createDatabasePool`)
  - Hàm kiểm tra kết nối (`testDatabaseConnection`)
- **File Data Access Layer**: [peer/db/message-store.ts](file:///D:/P2P/secure-p2p-network/peer/db/message-store.ts)
  - Đóng gói toàn bộ các thao tác nghiệp vụ CRUD (Lưu tin nhắn, hàng đợi offline, phân trang lịch sử, xử lý DHT KV store)
- **File Quản lý Xác thực & Tài khoản**: [peer/db/user-service.ts](file:///D:/P2P/secure-p2p-network/peer/db/user-service.ts)
  - Đăng ký, đăng nhập, băm mật khẩu bảo mật (scrypt + salt), thẩm định chính sách mật khẩu mạnh, chống tấn công Brute-force
- **File Cấp phát & Xác thực JWT**: [peer/db/jwt-service.ts](file:///D:/P2P/secure-p2p-network/peer/db/jwt-service.ts)
  - Ký và xác minh JWT Token bằng thuật toán `HMAC-SHA256` chống can thiệp trái phép
- **File Khởi tạo Schema & Migrations**: [peer/db/migrations.ts](file:///D:/P2P/secure-p2p-network/peer/db/migrations.ts)
  - Tự động tạo bảng và nâng cấp schema từ V1 đến V7 (Bao gồm bảng `users` và các trường khóa bảo vệ)
- **File Cấu hình kết nối**: [common/config.ts](file:///D:/P2P/secure-p2p-network/common/config.ts) & [config.json](file:///D:/P2P/secure-p2p-network/config.json)
  - Đọc thiết lập kết nối (`host`, `port`, `database`, `user`, `password`, `max pool`) và hỗ trợ override qua biến môi trường (`DB_HOST`, `DB_PORT`, `DB_NAME`, v.v.).

---

## 2. Sơ đồ Thực thể - Mối quan hệ (ERD)

```mermaid
erDiagram
    USERS ||--o{ CONVERSATIONS : "owns_node (node_owner)"
    CONVERSATIONS ||--o{ MESSAGES : "contains (1:N)"
    CONVERSATIONS ||--o{ FILES : "attachments (1:N)"
    FILES ||--o| MESSAGES : "referenced_by (file_id)"

    USERS {
        text id PK "UUID định danh người dùng"
        text username UK "Tên đăng nhập duy nhất"
        text password_hash "Băm mật khẩu scrypt"
        text password_salt "Salt ngẫu nhiên 16 bytes"
        text display_name "Tên hiển thị"
        integer node_port "Cổng WebSocket Peer"
        integer failed_attempts "Số lần nhập sai liên tiếp"
        bigint last_failed_at "Thời điểm nhập sai gần nhất"
        bigint locked_until "Thời điểm hết hạn khóa 15p"
        bigint created_at "Thời điểm tạo"
    }

    CONVERSATIONS {
        text id PK "conv_{peer_name}"
        text node_owner PK "Tên node sở hữu"
        text peer_name UK "Tên peer đối tác"
        bigint created_at "Thời điểm tạo"
        bigint last_message_at "Thời điểm tin cuối"
    }

    MESSAGES {
        text message_id PK "UUID định danh tin nhắn"
        text node_owner PK "Tên node sở hữu"
        text conversation_id FK "Liên kết conversations(id)"
        text sender "Người gửi"
        text receiver "Người nhận"
        text direction "in | out"
        integer seq "Sequence counter"
        bigint timestamp "Thời gian gửi"
        text body "Nội dung chat"
        text status "pending | sent | delivered | failed"
        text type "chat | file"
        text file_id "ID file nếu có"
        bigint created_at "Thời điểm ghi nhận"
        text nonce "Chống replay attack"
        text mac_or_signature "Xác thực toàn vẹn"
        text route "JSON mảng tuyến đường Mesh Relay"
        text relayed_by "Peer trung gian chuyển tiếp"
        integer lamport_clock "Leslie Lamport Logical Clock"
        text vector_clock "Vector Clock JSON"
    }

    FILES {
        text file_id PK "UUID file"
        text node_owner PK "Tên node sở hữu"
        text conversation_id FK "Liên kết conversations(id)"
        text file_name "Tên tệp gốc"
        bigint size "Kích thước tệp (bytes)"
        text hash "SHA-256 toàn vẹn"
        text status "transferring | completed | failed"
        text local_path "Đường dẫn file trên đĩa"
        text direction "in | out"
        bigint created_at "Thời điểm tạo"
    }

    PEERS {
        text peer_name PK "Tên hiển thị peer"
        text node_owner PK "Tên node sở hữu"
        text last_ip "Địa chỉ IP gần nhất"
        integer last_port "Cổng TCP gần nhất"
        bigint last_seen "Thời điểm thấy online"
        text node_id "DHT Node ID (SHA-1)"
        text public_key "Khóa công khai Ed25519"
    }

    DHT_STORAGE {
        text key PK "160-bit SHA-1 Key"
        text node_owner PK "Tên node sở hữu"
        text value "JSON nội dung lưu trữ"
        bigint expires_at "Thời gian hết hạn (TTL)"
        text publisher "Node công bố dữ liệu"
        integer is_local_published "1 nếu do chính node này tạo"
        bigint updated_at "Thời điểm cập nhật"
        integer lamport_clock "Lamport Clock giải quyết xung đột"
        integer version "Phiên bản dữ liệu"
    }

    NODE_IDENTITY {
        text id PK "UUID bản ghi"
        text node_owner PK "Tên node sở hữu"
        text display_name "Tên hiển thị"
        text public_key "Ed25519 Public Key (PEM)"
        text private_key "Ed25519 Private Key (PEM)"
        text node_id "Node ID 160-bit (SHA1 PublicKey)"
        bigint created_at "Thời điểm tạo"
    }

    NODE_STATE {
        text key PK "lamport_clock, sequence, etc."
        text node_owner PK "Tên node sở hữu"
        text value "Giá trị trạng thái"
        bigint updated_at "Thời điểm cập nhật"
    }

    SCHEMA_VERSION {
        integer version PK "Phiên bản migration (1..5)"
        bigint applied_at "Thời điểm thực thi"
    }
```

---

## 3. Mô tả chi tiết các bảng

| Bảng | Mục đích | Khóa chính (Composite PK) |
|---|---|---|
| **`conversations`** | Quản lý phiên hội thoại giữa node hiện tại và từng peer đối tác | `(id, node_owner)` |
| **`messages`** | Lưu trữ toàn bộ tin nhắn chat, trạng thái (pending/sent/delivered), dấu thời gian vật lý & đồng hồ logic Lamport/Vector Clock, tuyến định tuyến đa chặng Mesh Relay | `(message_id, node_owner)` |
| **`files`** | Quản lý thông tin truyền nhận tệp (hash SHA-256, kích thước, tiến độ, đường dẫn lưu trữ local) | `(file_id, node_owner)` |
| **`peers`** | Danh bạ các peer đã từng liên lạc (IP, TCP Port, Ed25519 Public Key, Node ID) | `(peer_name, node_owner)` |
| **`dht_storage`** | Bảng Key-Value phân tán Kademlia (lưu trữ phân tán, Mailbox tin nhắn offline, phục vụ Self-Healing) | `(key, node_owner)` |
| **`node_identity`** | Cặp khóa mật mã học Ed25519 và Node ID cố định của từng peer | `(id, node_owner)` |
| **`node_state`** | Trạng thái đồng hồ Lamport Clock nhằm đảm bảo tính đơn điệu (Monotonicity) qua các lần khởi động | `(key, node_owner)` |
| **`schema_version`** | Theo dõi lịch sử migration phiên bản CSDL | `version` |
