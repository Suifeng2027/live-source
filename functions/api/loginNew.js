/**
 * Cloudflare Pages Function: POST /api/loginNew
 * 
 * 接收 POST 请求，忽略登录参数，返回未登录状态
 */

export async function onRequest(context) {
  // 处理 OPTIONS 预检请求
  if (context.request.method === 'OPTIONS') {
    console.log('[LOGIN] OPTIONS');
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, timestamp, sign, nonce'
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
    console.log('[LOGIN] 请求进入');
    console.log('[LOGIN] method:', context.request.method);
    
    // 打印 headers
    const headers = context.request.headers;
    const signValue = headers.get('sign') || '(无)';
    console.log('[LOGIN] headers:');
    console.log('  timestamp:', headers.get('timestamp') || '(无)');
    console.log('  sign:', signValue !== '(无)' ? `${signValue.length} 字符` : '(无)');
    console.log('  nonce:', headers.get('nonce') || '(无)');
    
    // 读取请求 body
    const requestBody = await context.request.text();
    
    let postData = {};
    try {
      postData = JSON.parse(requestBody || '{}');
    } catch (e) {
      console.log('[LOGIN] body (非JSON):', requestBody ? `${requestBody.substring(0, 100)}...` : '(空)');
    }
    
    console.log('[LOGIN] body:');
    if (postData.str) {
      console.log('  str长度:', postData.str.length, '字符');
    } else {
      console.log('  str:', '(无)');
    }

    const response = {
      code: 0,
      msg: '成功',
      data: "cFBi0rP+QgublcYKkyietaE0OH/zg30XvLKa1rFzEjYhAh+96JLt/eWSpc2Fv4beGfhUoaUfkQOZJqIrkY1nn3LIwd54IXSbV/KeDSDNc2lhJQUZHCd67+k1knLn8/MaNuTLd5gZ2/meA+zD9X4SHg=="
    };

    console.log('[LOGIN] response:', JSON.stringify(response));

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (error) {
    console.error('[LOGIN] error:', error);
    
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
