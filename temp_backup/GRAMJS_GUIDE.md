GramJS 开发指南 (AI Context)
📌 核心准则
优先使用英文文档：GramJS 的官方文档和源码注释均以英文为准。

MTProto vs Bot API：GramJS 使用的是 MTProto。除非明确说明是 Bot 身份，否则请按 User 身份处理逻辑。

API 查找：所有 Telegram 原始方法都位于 client.invoke(new Api.category.method({ ... })) 下。

🏗 基础架构与初始化
1. 客户端实例
始终确保 client 已连接并认证。

JavaScript

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

// 必须优先从环境变量读取凭据
const client = new TelegramClient(
    new StringSession(process.env.TELEGRAM_SESSION || ""),
    Number(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH,
    { connectionRetries: 5 }
);
2. 身份验证流程
用户登录：需要 phoneNumber, phoneCode, password (如果开启了 2FA)。

机器人登录：使用 client.start({ botAuthToken: "..." })。

🛠 关键模式与实践
1. 处理 BigInt
Telegram 的 ID（如 chatId, userId, accessHash）通常是 64 位整数。

规则：在 GramJS 中，这些值必须使用 BigInt。

示例：peer: BigInt("-100123456789")。

2. Peer 对象的处理
大多数方法需要一个 Entity 或 Peer 对象。

推荐做法：使用 await client.getEntity(peerId) 获取完整的 Entity，GramJS 会自动处理缓存和 Access Hash。

缓存机制：尽量利用内部缓存，避免频繁调用 getEntity。

3. 原始 API 调用 (Raw API)
当便捷方法（如 client.sendMessage）不够用时，使用 Api 类：

JavaScript

const result = await client.invoke(
    new Api.messages.GetHistory({
        peer: "username",
        limit: 10,
    })
);
🔄 事件监听 (Updates)
GramJS 的事件监听基于 NewMessage 等类：

JavaScript

const { NewMessage } = require("telegram/events");

client.addEventHandler(async (event) => {
    const message = event.message;
    // 逻辑处理
}, new NewMessage({ incoming: true }));
⚠️ 常见陷阱与解决办法
FloodWaitError：如果请求过快，Telegram 会返回此错误。务必捕获此错误并进行等待，或者使用插件限制频率。

Session 持久化：确保在登录成功后，通过 client.session.save() 保存 session 字符串，以便下次免密登录。

文件上传：大型文件必须通过 client.uploadFile 分片上传。

JSON 序列化：由于包含 BigInt，直接对 API 返回结果使用 JSON.stringify 会报错。需使用库自带的序列化工具或自定义 replacer。

🔍 参考资源
官方文档: https://gram.js.org/

TL 架构参考: https://core.telegram.org/methods (搜索具体的 API 名称)

源码阅读: node_modules/telegram/tl/api.d.ts 是查找参数类型的最快途径。

Windsurf 指令： 在修改代码前，请先检查当前逻辑是否符合上述 BigInt 处理规则和 Entity 获取最佳实践。如果你需要调用原始 API，请参考 Api 类的结构。