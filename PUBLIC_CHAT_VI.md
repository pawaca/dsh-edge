# BilaBot2 · Trò chuyện thử nghiệm công khai

Nhánh này bổ sung **chế độ Public Chat** độc lập vào `dsh-edge`:

- Không cần đăng nhập để dùng `/`; giao diện tiếng Việt, hỗ trợ điện thoại.
- Mọi người dùng dùng chung **một DEEPSEEK_API_KEY bí mật** và **một DEEPSEEK_MODEL** do chủ Worker cấu hình.
- Lịch sử phiên (tin nhắn, tên phiên) được lưu **chỉ trong localStorage của từng trình duyệt**; có nút xuất JSON và xóa lịch sử.
- Worker chỉ xử lý request rồi gọi DeepSeek; không ghi lời nhắn vào SQLite, Durable Objects, KV, R2 hay analytics ứng dụng.
- Hoàn toàn tách khỏi các tuyến Harness nhiều quyền: phiên owner, workspace, shell, MCP, settings **vẫn đòi hỏi mật khẩu chủ sở hữu**. ĐỪNG xóa `DSH_EDGE_ACCESS_KEY`.
- Giới hạn 5 yêu cầu / 60 giây trên từng IP và Cloudflare edge location (xấp xỉ). Tắt Workers observability theo cấu hình nhánh; cần kiểm tra thêm account-level request logs, WAF, proxies hoặc nhà cung cấp API để có cam kết riêng tư phù hợp.

## Cloudflare: thiết lập

1. Clone đúng nhánh thay đổi, dùng Node.js >= 22.19 và pnpm 11.7.0. Chạy `pnpm --dir apps/dsh-edge/standalone install --frozen-lockfile` trước, sau đó `pnpm install --frozen-lockfile`. Kiểm tra với `pnpm run check` và chạy `pnpm --filter dsh-edge run deploy:public` để **build từ source chính nhánh này** rồi triển khai chế độ Direct lên Worker `dsh-edge`. Lệnh này dùng Wrangler đã đăng nhập hoặc Cloudflare token trong môi trường; không chạy `npx dsh-edge install` từ npm. Nếu tên Worker đang triển khai khác `dsh-edge`, chạy riêng: `pnpm --filter dsh-edge run bundle:direct && node apps/dsh-edge/scripts/deploy-public.mjs TEN_WORKER`.
2. Đặt `DEEPSEEK_API_KEY` dưới dạng secret trong Cloudflare Workers, không đặt vào `vars` hay HTML. Ví dụ, từ `apps/dsh-edge`: `npx wrangler secret put DEEPSEEK_API_KEY` (cần dùng đúng environment nếu deploy isolated/container).
3. `wrangler.jsonc` đã có `DSH_EDGE_PUBLIC_CHAT=enabled`, `DSH_EDGE_PUBLIC_MAX_TOKENS=1024`, giới hạn 5 lượt / 60 giây và `observability.enabled=false`.
4. `DEEPSEEK_MODEL=deepseek-flash` đã được khai báo trong `wrangler.jsonc` cho Direct, Isolated và Container. Chỉ chủ website có thể chỉnh model; không cho khách đổi model.
5. Vẫn phải cấu hình secret `DSH_EDGE_ACCESS_KEY` (chuỗi ngẫu nhiên tối thiểu 32 byte) cho quyền quản trị gốc.
6. Kiểm tra `GET /api/public/config` trả về model và `ready:true`. Mở `/` sẽ vào BilaBot không đăng nhập. `/login` là cửa đăng nhập chủ sở hữu; đăng nhập thành công sẽ chuyển tới `/owner` (Harness nguyên gốc).

## Biên riêng tư, bảo mật và chi phí

BilaBot2 không thu thập hoặc lưu trữ **nội dung hội thoại** trong máy chủ ứng dụng ở chế độ Public Chat. Tuy nhiên **nội dung mỗi yêu cầu và một phần lịch sử gần đây được gửi đến DeepSeek để sinh câu trả lời**; các nhà cung cấp cơ sở hạ tầng có chính sách xử lý dữ liệu riêng. Người dùng không nên nhập thông tin cá nhân nhạy cảm. Tắt observability trong mã cấu hình không chắc chắn tắt mọi log cấp tài khoản. CORS / kiểm tra Origin không phải biện pháp ngăn bot; Cloudflare WAF/Turnstile (nếu cho phép), bot protection và budget cap ở nhà cung cấp nên được bật trước khi quảng bá rộng rãi.

Giới hạn dùng Workers rate limiting mang tính **ước lượng theo vị trí**, không phải hạn mức toàn cầu nghiêm ngặt. Nếu có đông người dùng, cần thêm hạn mức chi tiêu từ tài khoản DeepSeek hoặc bộ đếm nghiêm ngặt (đánh đổi với việc lưu metadata tối thiểu). Không định danh ổn định người dùng; IP có thể là IP NAT chia sẻ. Hiện nhánh này chỉ hỗ trợ chat văn bản, không mở tool execution, upload, MCP hay phiên Harness cho khách.

## Kiểm tra nhanh

- Không cookie: `GET /` trả HTML tiếng Việt; `GET /public/app.js` trả script.
- Không cookie: `GET /api/public/config` trả JSON không chứa API key.
- `POST /api/public/chat` với header `Origin` trùng Worker origin và `Content-Type: application/json`; payload `{"messages":[{"role":"user","content":"Xin chào"}]}`.
- Sai Origin bị 403; payload rỗng bị 400; quá 5 lượt có thể bị 429.
- Không cookie: `GET /api/sessions` phải bị 401, `GET /login` vẫn có trang owner.
- Chạy `pnpm run check` và `pnpm run build` trước khi merge/deploy. **Nhánh chưa được xác nhận CI hay triển khai Cloudflare thực tế**.

## Giới hạn truy cập dashboard

Có quyền xem Dashboard Cloudflare trên máy cá nhân **không tự động cho phép tác nhân ChatGPT trong chat gọi API**. Cần chạy Wrangler bằng máy đã đăng nhập (`npx wrangler login`) hoặc một công cụ có quyền Worker deployment và secrets. Đừng gửi DeepSeek key hay Owner key trong hội thoại; điền trực tiếp trong Cloudflare Dashboard > Workers & Pages > dsh-edge > Settings > Variables and Secrets > Add > Secret > Deploy. Tên secrets: `DEEPSEEK_API_KEY`, `DSH_EDGE_ACCESS_KEY`. Bản deploy không chứa các giá trị này.
