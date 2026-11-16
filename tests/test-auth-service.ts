import { createDatabasePool } from "../peer/db/connection.js";
import { initDatabase } from "../peer/db/migrations.js";
import { UserService } from "../peer/db/user-service.js";

async function runAuthTest() {
  console.log("=== KIỂM THỬ TÍNH NĂNG ĐĂNG KÝ & ĐĂNG NHẬP VỚI POSTGRESQL ===");
  const pool = createDatabasePool();

  try {
    console.log("1. Chạy Migrations (Bao gồm V6 - bảng users)...");
    await initDatabase(pool);

    const userService = new UserService(pool);

    console.log("2. Kiểm tra tài khoản mặc định alice, bob, charlie...");
    const users = await userService.listUsers();
    console.log(`   Tìm thấy ${users.length} tài khoản trong DB:`);
    for (const u of users) {
      console.log(`   - [${u.username}] Display: '${u.displayName}', Node Port: ${u.nodePort}`);
    }

    console.log("3. Kiểm tra đăng nhập với Alice (mật khẩu 123456)...");
    const loginAlice = await userService.login("alice", "123456");
    if (!loginAlice.success || !loginAlice.user) {
      throw new Error(`Đăng nhập Alice thất bại: ${loginAlice.error}`);
    }
    console.log(`   ✅ Đăng nhập Alice thành công! Port: ${loginAlice.user.nodePort}`);

    console.log("4. Kiểm tra đăng nhập sai mật khẩu...");
    const loginFail = await userService.login("alice", "wrong_password");
    if (loginFail.success) {
      throw new Error("Lỗi: Mật khẩu sai nhưng lại cho đăng nhập!");
    }
    console.log(`   ✅ Chặn đúng khi sai mật khẩu: "${loginFail.error}"`);

    console.log("5. Kiểm tra đăng ký tài khoản mới 'david'...");
    const regResult = await userService.register("david", "pass123", "David Nguyen", 3004);
    if (!regResult.success && regResult.error?.includes("đã tồn tại")) {
      console.log("   (Tài khoản david đã có sẵn từ trước, bỏ qua tạo mới)");
    } else if (regResult.success) {
      console.log(`   ✅ Đăng ký tài khoản david thành công! Port: ${regResult.user?.nodePort}`);
    }

    console.log("6. Kiểm tra đăng nhập với tài khoản vừa tạo (david / pass123)...");
    const loginDavid = await userService.login("david", "pass123");
    if (!loginDavid.success) {
      throw new Error(`Đăng nhập David thất bại: ${loginDavid.error}`);
    }
    console.log(`   ✅ Đăng nhập David thành công!`);

    console.log("\n🎉 TOÀN BỘ CÁC BƯỚC KIỂM THỬ XÁC THỰC ĐỀU THÀNH CÔNG!");
  } finally {
    await pool.end();
  }
}

runAuthTest().catch((err) => {
  console.error("❌ Kiểm thử thất bại:", err);
  process.exit(1);
});
