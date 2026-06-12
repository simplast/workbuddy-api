/**
 * 测试脚本：验证 proxy 是否正常工作
 * 用法：CODEBUDDY_API_KEY=xxx node src/test.js
 */
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, generateText } from 'ai';

const PORT = process.env.PORT || 3456;
const BASE = `http://127.0.0.1:${PORT}/v1`;

// 创建一个指向本地 proxy 的 OpenAI provider
// 注意：必须用 .chat() 而不是直接调用 provider，否则 AI SDK v3+ 会走 /v1/responses
const local = createOpenAI({
  baseURL: BASE,
  apiKey: 'dummy', // proxy 已经注入了真实 token，这里随意填
});

async function testNonStream() {
  console.log('\n── 非流式测试 ──');
  try {
    const result = await generateText({
      model: local.chat('default-model-lite'),
      messages: [{ role: 'user', content: '用一句话介绍你自己' }],
      maxTokens: 200,
    });
    console.log('✓ 非流式响应:', result.text?.slice(0, 100));
    console.log('  Token 用量:', result.usage);
  } catch (err) {
    console.error('✗ 非流式失败:', err.message);
  }
}

async function testStream() {
  console.log('\n── 流式测试 ──');
  try {
    const result = streamText({
      model: local.chat('default-model-lite'),
      messages: [{ role: 'user', content: '用一句话介绍你自己' }],
      maxTokens: 200,
    });

    let text = '';
    for await (const chunk of result.textStream) {
      text += chunk;
      process.stdout.write(chunk);
    }
    console.log('\n✓ 流式响应完成，总长度:', text.length);
  } catch (err) {
    console.error('✗ 流式失败:', err.message);
  }
}

async function testCurl() {
  console.log('\n── curl 兼容性测试 ──');
  try {
    const resp = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'default-model-lite',
        messages: [{ role: 'user', content: 'say hi' }],
        max_tokens: 50,
      }),
    });
    const data = await resp.json();
    console.log('✓ curl 响应:', data.choices?.[0]?.message?.content?.slice(0, 100));
  } catch (err) {
    console.error('✗ curl 失败:', err.message);
  }
}

console.log(`Testing proxy at ${BASE}`);
(async () => {
  await testCurl();
  await testNonStream();
  await testStream();
  console.log('\n── 测试完成 ──');
})();
