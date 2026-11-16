import { createDatabasePool } from "../peer/db/connection.js";
import { initDatabase } from "../peer/db/migrations.js";
import { UserService } from "../peer/db/user-service.js";
import { JwtService } from "../peer/db/jwt-service.js";

async function runSecurityTests() {
  console.log("================================================================================");
  console.log("   KIỂM THỬ BỘ BA TÍNH NĂNG BẢO MẬT: JWT TOKEN + BRUTE-FORCE LOCK + PASSWORD POLICY");
  console.log("================================================================================\n");

  // PHẦN 1: KIỂM THỬ CHÍNH SÁCH MẬT KHẨU MẠNH (Password Policy)
  console.log("[TEST 1] Kiểm tra Chính sách Mật khẩu mạnh (Password Policy):");
  const testCases = [
    { pass: "short1!", expected: false, reason: "Dưới 8 ký tự" },
    { pass: "nouppercase123!", expected: false, reason: "Không có chữ hoa" },
    { pass: "NOLOWERCASE123!", expected: false, reason: "Không có chữ thường" },
    { pass: "NoNumbersHere!", expected: false, reason: "Không có số" },
    { pass: "NoSpecialChars123", expected: false, reason: "Không có ký tự đặc biệt" },
    { pass: "P2p@Secure2026", expected: true, reason: "Đạt chuẩn 8+ ký tự, hoa, thường, số, đặc biệt" }
  ];

  for (const tc of testCases) {
    const res = UserService.validatePasswordPolicy(tc.pass);
    if (res.valid !== tc.expected) {
      throw new Error(`Test password thất bại cho '${tc.pass}': kỳ vọng ${tc.expected} nhưng nhận ${res.valid}`);
    }
    console.log(`   ${res.valid ? "✅" : "🛡️"} Mật khẩu: '${tc.pass}' -> ${res.valid ? "HỢP LỆ" : "BỊ CHẶN: " + res.error} (${tc.reason})`);
  }

  // PHẦN 2: KIỂM THỬ CẤP PHÁT VÀ XÁC THỰC JWT TOKEN (HMAC-SHA256)
  console.log("\n[TEST 2] Kiểm tra JWT Token (Ký số HMAC-SHA256 & Kiểm tra chữ ký):");
  const samplePayload = {
    userId: "user_test_uuid_123",
    username: "alice",
    displayName: "Alice Secure",
    nodePort: 3001
  };

  const token = JwtService.sign(samplePayload, 3600); // 1 giờ
  console.log(`   1. Tạo JWT Token thành công: ${token.substring(0, 35)}...`);

  const verified = JwtService.verify(token);
  if (!verified.valid || verified.payload?.username !== "alice") {
    throw new Error("Xác thực JWT hợp lệ thất bại!");
  }
  console.log(`   ✅ 2. Xác thực Token hợp lệ: Username '${verified.payload?.username}', Node Port: ${verified.payload?.nodePort}`);

  // Thử giả mạo token (Thay đổi 1 ký tự trong payload)
  const parts = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({ ...samplePayload, username: "hacker" })).toString("base64url");
  const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
  const tamperedVerify = JwtService.verify(tamperedToken);
  if (tamperedVerify.valid) {
    throw new Error("Lỗi nghiêm trọng: Token bị giả mạo nhưng vẫn xác thực thành công!");
  }
  console.log(`   ✅ 3. Chống giả mạo: Token bị chỉnh sửa payload đã bị chặn đúng: "${tamperedVerify.error}"`);

  // PHẦN 3: KIỂM THỬ RATE LIMITING & ACCOUNT LOCKOUT (CHỐNG BRUTE-FORCE)
  console.log("\n[TEST 3] Kiểm tra Chống Brute-force (Nhập sai 5 lần liên tiếp -> Khóa 15 phút):");
  const pool = createDatabasePool();

  try {
    await initDatabase(pool);
    const userService = new UserService(pool);

    const testUsername = "victim_" + Date.now();
    const testPassword = "StrongPassword@2026";

    // 1. Tạo tài khoản thử nghiệm
    const regRes = await userService.register(testUsername, testPassword, "Victim User");
    if (!regRes.success) {
      throw new Error(`Đăng ký tài khoản thử nghiệm thất bại: ${regRes.error}`);
    }
    console.log(`   1. Đã tạo tài khoản kiểm thử '${testUsername}' (Cổng: ${regRes.user?.nodePort})`);

    // 2. Thử nhập sai mật khẩu 4 lần đầu
    for (let attempt = 1; attempt <= 4; attempt++) {
      const loginRes = await userService.login(testUsername, "wrong_password");
      if (loginRes.success) throw new Error("Nhập sai nhưng lại thành công!");
      console.log(`   - Thử lần ${attempt}: Nhập sai mật khẩu -> Cảnh báo: "${loginRes.error}" (Còn ${loginRes.remainingAttempts} lần)`);
    }

    // 3. Lần thứ 5: Phải kích hoạt Khóa tài khoản (Account Lockout) 15 phút
    const attempt5 = await userService.login(testUsername, "wrong_password");
    if (attempt5.success || !attempt5.lockedMinutes) {
      throw new Error("Lần thứ 5 không kích hoạt khóa tài khoản!");
    }
    console.log(`   🚫 Lần thứ 5: ĐÃ KÍCH HOẠT KHÓA TÀI KHOẢN! "${attempt5.error}"`);

    // 4. Lần thứ 6 (Kể cả nhập đúng mật khẩu trong lúc đang bị khóa vẫn bị từ chối)
    const attempt6 = await userService.login(testUsername, testPassword);
    if (attempt6.success) {
      throw new Error("Tài khoản đang bị khóa nhưng vẫn cho đăng nhập!");
    }
    console.log(`   ✅ Kể cả nhập ĐÚNG mật khẩu khi đang bị khóa: Bị chặn thành công! "${attempt6.error}"`);

    // 5. Mở khóa và đăng nhập thành công
    await pool.query("UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE username = $1", [testUsername]);
    const loginOk = await userService.login(testUsername, testPassword);
    if (!loginOk.success || !loginOk.token) {
      throw new Error("Đăng nhập sau khi mở khóa thất bại!");
    }
    console.log(`   🎉 Mở khóa và đăng nhập lại thành công! Cấp JWT Token: ${loginOk.token.substring(0, 30)}...`);

    console.log("\n================================================================================");
    console.log("   🎉 TOÀN BỘ 3 TÍNH NĂNG BẢO MẬT ĐỀU ĐẠT CHUẨN XUẤT SẮC 100%!");
    console.log("================================================================================");
  } finally {
    await pool.end();
  }
}

runSecurityTests().catch((err) => {
  console.error("❌ Kiểm thử bảo mật thất bại:", err);
  process.exit(1);
});
