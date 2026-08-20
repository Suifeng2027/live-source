/**
 * Cloudflare Pages Function: GET /api/getTime
 * 
 * 返回当前服务器 Unix 时间戳（毫秒）
 */

export async function onRequest(context) {
  const requestTime = new Date().toISOString();
  const currentTime = Math.floor(Date.now() / 1000);  // 秒时间戳（10位）
  
  console.log('[GET_TIME] 请求进入');
  console.log('[GET_TIME] 请求时间:', requestTime);
  console.log('[GET_TIME] 返回curtime值:', currentTime);
  
  const response = {
    curtime: currentTime
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
