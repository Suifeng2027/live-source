/**
 * Cloudflare Pages Function: POST /api/check
 * 
 * 接收 POST 请求，忽略签名验证，返回成功
 */

export async function onRequest(context) {
  // 处理 OPTIONS 预检请求
  if (context.request.method === 'OPTIONS') {
    console.log('[CHECK] OPTIONS');
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, timestamp, sign, nonce, User-Agent'
      }
    });
  }

  // 只接受 POST 请求
  if (context.request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  try {
    console.log('[CHECK] 请求进入');
    console.log('[CHECK] request method:', context.request.method);
    
    // 打印 headers
    const headers = context.request.headers;
    console.log('[CHECK] headers:');
    console.log('  timestamp:', headers.get('timestamp') || '(无)');
    console.log('  sign:', headers.get('sign') || '(无)');
    console.log('  nonce:', headers.get('nonce') || '(无)');
    
    // 读取请求 body
    const requestBody = await context.request.text();
    
    let postData = {};
    try {
      postData = JSON.parse(requestBody || '{}');
    } catch (e) {
      console.log('[CHECK] POST body (非JSON):', requestBody || '(空)');
    }
    
    console.log('[CHECK] POST body:');
    console.log('  wifimac:', postData.wifimac || '(无)');
    console.log('  ethmac:', postData.ethmac || '(无)');
    console.log('  channelCode:', postData.channelCode || '(无)');
    console.log('  authinfo:', postData.authinfo || '(无)');

    const response = {
      code: 0
    };

    console.log('[CHECK] response:', JSON.stringify(response));

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (error) {
    console.error('[CHECK] error:', error);
    
    return new Response(JSON.stringify({ 
      code: -1,
      msg: 'Server error'
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
