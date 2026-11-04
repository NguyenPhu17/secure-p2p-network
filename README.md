# 🔐 Secure P2P Network with CA/KDC & MITM Proxy
> **Môn học**: Các Hệ Thống Phân Tán (Distributed Systems)  
> **Tài liệu tham khảo**: *Distributed Systems 4th Ed. — Maarten van Steen & Andrew S. Tanenbaum (§9.1–9.3)*

---

## 📌 Tổng quan Dự án

Hệ thống mạng phân tán ngang hàng (Peer-to-Peer) an toàn tích hợp Trung tâm chứng thực số (CA/KDC) và một trạm Proxy đánh cắp/can thiệp dữ liệu trung gian (MITM Intercept Proxy). Dự án cho phép:
1. **Đăng ký định danh & cấp chứng chỉ X.509**: Node đăng ký Public Key lên CA Server và nhận Digital Certificate có chữ ký điện tử RSA-SHA256.
2. **Xác thực lẫn nhau (Mutual Authentication)**: Giao thức bắt tay 3 bước với Challenge-Response (Nonce) chống tấn công phát lại (Replay Attack).
3. **Trao đổi khóa phiên (Session Key Exchange)**: Sinh khóa đối xứng AES-256-GCM ngẫu nhiên, mã hóa bảo vệ bằng RSA-OAEP và ký số RSA-PSS chống chối bỏ.
4. **Truyền tin nhắn & file bảo mật**: Mã hóa dữ liệu bằng AES-256-GCM, kiểm tra tính toàn vẹn 3 lớp (Nonce/Timestamp, Auth Tag, RSA Signature).
5. **Mô phỏng tấn công thời gian thực qua MITM Proxy**: Can thiệp gói tin trực tiếp từ Dashboard: Tamper (sửa bit ciphertext), Replay (phát lại bản tin cũ), Spoof (giả mạo chứng chỉ số).
6. **Giao diện trực quan 3 cột (React Dashboard)**: Quan sát dòng gói tin chuyển động theo thời gian thực (Sequence chart & Packet Inspector) giữa Sender (Node A), MITM Proxy, và Receiver (Node B).

---

## 🏗️ Cấu trúc Mạng & Cổng Dịch vụ (Docker Bridge: `p2p-secure-net`)

| Dịch vụ | Docker Container | Port Host | Mô tả chức năng |
| :--- | :--- | :--- | :--- |
| **CA / KDC Server** | `p2p_ca_server` | `8000` | Root Certificate Authority, cấp X.509 certs, danh bạ peer discovery |
| **Peer Node A** | `p2p_peer_a` | `8001` | Servant Node A (Sender/Initiator) |
| **Peer Node B** | `p2p_peer_b` | `8002` | Servant Node B (Receiver/Responder) |
| **Peer Node C** | `p2p_peer_c` | `8003` | Servant Node C (Additional peer) |
| **MITM Proxy** | `p2p_mitm_proxy` | `8080` | Reverse Proxy chặn bắt HTTP/WS, phân tích gói tin, can thiệp tấn công |
| **Frontend UI** | `p2p_frontend_ui` | `3000` | Bảng điều khiển giám sát 3 cột (React + Vite + TailwindCSS) |

---

## 📂 Cấu trúc Thư mục Monorepo

```
secure-p2p-network/
├── docker-compose.yml              # Quản lý toàn bộ 6 container trong mạng ảo
├── .env.example                    # Cấu hình biến môi trường mẫu
├── .gitignore                      # Cấu hình loại trừ git
├── README.md                       # Tài liệu hướng dẫn
├── docs/
│   └── implementation-plan.md     # Kế hoạch chi tiết 5 giai đoạn
├── ca_server/                      # PKI Root CA Server (FastAPI)
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── config.py
│   ├── main.py
│   ├── core/                       # Crypto primitives, cert store
│   └── api/                        # REST & WebSocket endpoints
├── peer_node/                      # Peer Node Servant (FastAPI)
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── config.py
│   ├── main.py
│   ├── core/                       # Identity, handshake, session management
│   └── api/                        # Peer REST endpoints & dashboard WS
├── mitm_proxy/                     # MITM Relay Proxy (FastAPI + Async HTTP)
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── config.py
│   ├── main.py
│   ├── core/                       # Interceptor, packet store, attack engine
│   └── api/                        # Control API & stream WS
├── frontend_ui/                    # Giao diện giám sát trực quan (React + TS + Tailwind)
│   ├── Dockerfile
│   ├── package.json
│   ├── src/
│   │   ├── components/             # NodePanel, MitmPanel, PacketInspector
│   │   ├── hooks/                  # WebSocket hooks
│   │   └── store/                  # Zustand state
└── shared/                         # Thư viện tiện ích dùng chung
    └── crypto_utils.py
```

---

## 🚀 Hướng dẫn Khởi chạy Nhanh

### 1. Khởi chạy bằng Docker Compose (Khuyên dùng)

Đảm bảo máy tính đã cài đặt **Docker Desktop** và Docker daemon đang hoạt động:

```bash
# Khởi động toàn bộ 6 service
docker compose up --build -d

# Xem log các service
docker compose logs -f

# Dừng hệ thống
docker compose down
```

### 2. Kiểm tra Healthcheck của các Dịch vụ

Sau khi khởi chạy, kiểm tra trạng thái hoạt động:

* **CA Server**: [http://localhost:8000/health](http://localhost:8000/health) (API Docs: [http://localhost:8000/docs](http://localhost:8000/docs))
* **Peer Node A**: [http://localhost:8001/health](http://localhost:8001/health) (API Docs: [http://localhost:8001/docs](http://localhost:8001/docs))
* **Peer Node B**: [http://localhost:8002/health](http://localhost:8002/health) (API Docs: [http://localhost:8002/docs](http://localhost:8002/docs))
* **Peer Node C**: [http://localhost:8003/health](http://localhost:8003/health) (API Docs: [http://localhost:8003/docs](http://localhost:8003/docs))
* **MITM Proxy**: [http://localhost:8080/health](http://localhost:8080/health) (API Docs: [http://localhost:8080/docs](http://localhost:8080/docs))
* **Frontend Dashboard**: [http://localhost:3000](http://localhost:3000)

---

## 🛠️ Trạng thái Triển khai (Roadmap)

- [x] **Phase 0: Scaffolding & Khởi tạo Hạ tầng**
- [x] **Phase 1: Xây dựng CA Server & Thư viện Mật mã Cốt lõi**
- [x] **Phase 2: Phát triển Peer Node — Định danh, Bắt tay & Khóa phiên**
- [x] **Phase 3: Xây dựng MITM Proxy & Công cụ Tấn công Gói tin**
- [x] **Phase 4: Phát triển Giao diện Trực quan 3 Cột (Frontend Dashboard)**

