import 'dotenv/config';

export const config = {
  // CodeBuddy API Key (Bearer token)
  apiKey: process.env.CODEBUDDY_API_KEY || '',
  // CodeBuddy 后端地址
  baseURL: process.env.CODEBUDDY_BASE_URL || 'https://www.codebuddy.ai',
  // 本地 proxy 端口
  port: parseInt(process.env.PORT || '3456', 10),
  host: process.env.HOST || '127.0.0.1',
  // 默认模型
  defaultModel: process.env.DEFAULT_MODEL || 'default-model',

  // ── NVIDIA API (compact 模型代理) ──
  nvidia: {
    baseURL: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    apiKey: process.env.NVIDIA_API_KEY || '',
    models: (process.env.NVIDIA_MODELS || 'z-ai/glm-5.1').split(',').map(s => s.trim()),
    // 模型名映射：请求中的别名 → NVIDIA 真实模型名
    modelMap: Object.fromEntries(
      (process.env.NVIDIA_MODELS || 'z-ai/glm-5.1').split(',').map(s => {
        const m = s.trim();
        return [m, m.includes('/') ? m : process.env.NVIDIA_TARGET_MODEL || 'z-ai/glm-5.1'];
      })
    ),
  },
};

if (!config.apiKey) {
  console.error(
    '\n  ⚠  CODEBUDDY_API_KEY 未设置！\n' +
    '  请在 .env 文件中配置，或通过环境变量传入。\n' +
    '  获取方式：访问 https://www.codebuddy.ai/profile 创建 API Key，\n' +
    '  或在 CLI 登录后从浏览器 DevTools 提取 accessToken。\n'
  );
  process.exit(1);
}
