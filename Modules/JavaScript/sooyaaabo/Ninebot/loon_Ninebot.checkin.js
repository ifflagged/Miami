(() => {
  'use strict';

  const API = 'https://cn-cbu-gateway.ninebot.com/portal/api/user-sign/v2';
  const APP_STATUS =
    /^https:\/\/cn-cbu-gateway\.ninebot\.com\/app-api\/api\/user-sign\/v2\/my-page\/status(?:\?|$)/;
  const STORAGE_KEY = 'Ninebot.UIDAccounts.v1';
  const TITLE = '九号出行';

  function notify(subtitle, text, uid) {
    const body = `UID[${uid || '未获取'}]：${text.replace(/\s*[\r\n]+\s*/g, '')}`;
    console.log(`[${TITLE}] ${subtitle} | ${body}`);
    try {
      $notification.post(TITLE, subtitle, body);
    } catch (_) {
      console.log(`[${TITLE}] ${subtitle}，无法发送本地通知`);
    }
  }

  function readAccounts() {
    try {
      const raw = $persistentStore.read(STORAGE_KEY);
      if (raw == null) return Object.create(null);

      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error();
      }

      return Object.assign(Object.create(null), data);
    } catch (_) {
      throw new Error('无法读取本地凭证');
    }
  }

  function isValidUid(uid) {
    return typeof uid === 'string' && /^[0-9]+$/.test(uid) && /[1-9]/.test(uid);
  }

  function isValidCredential(value) {
    return typeof value === 'string' && value.trim().length > 0 && !/[\r\n\0]/.test(value);
  }

  function headerValue(headers, names) {
    for (const name of names) {
      const value = headers[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  function capture(request) {
    if (!APP_STATUS.test(request.url || '')) return;
    const headers = Object.create(null);
    for (const [name, value] of Object.entries(request.headers || {})) {
      headers[name.toLowerCase()] = value;
    }
    const uid = headerValue(headers, ['uid']);
    if (!isValidUid(uid)) {
      notify('获取失败', '签到页请求缺少有效 UID，请重新打开签到页。');
      return;
    }

    const authorization = headerValue(headers, ['access-token', 'authorization']);
    const deviceId = headerValue(headers, ['device-id', 'device_id']);
    if (!isValidCredential(authorization) || !isValidCredential(deviceId)) {
      notify('获取失败', '签到页请求缺少令牌或设备 ID，请重新打开签到页。', uid);
      return;
    }

    try {
      const accounts = readAccounts();
      const conflict = Object.entries(accounts).some(
        ([otherUid, entry]) => otherUid !== uid && entry && entry.authorization === authorization
      );
      if (conflict) {
        notify('获取失败', '该令牌已绑定其他 UID，请重新登录后再抓取。', uid);
        return;
      }

      const previous = accounts[uid];
      if (previous && previous.authorization === authorization && previous.deviceId === deviceId) {
        notify('获取成功', '签到凭证已保存。', uid);
        return;
      }

      accounts[uid] = {
        authorization: authorization.trim(),
        deviceId: deviceId.trim()
      };
      if (!$persistentStore.write(JSON.stringify(accounts), STORAGE_KEY)) {
        notify('获取失败', '无法保存本地凭证。', uid);
        return;
      }
      notify('获取成功', previous ? '已更新签到凭证。' : '已保存签到凭证。', uid);
    } catch (_) {
      notify('获取失败', '无法读写本地凭证。', uid);
    }
  }

  function apiRequest(account, method, endpoint, label, payload) {
    return new Promise((resolve, reject) => {
      const options = {
        url: `${API}/${endpoint}`,
        timeout: 10000,
        'auto-redirect': false,
        'auto-cookie': false,
        insecure: false,
        headers: {
          Accept: 'application/json, text/plain, */*',
          Authorization: account.authorization,
          'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
          'Content-Type': 'application/json',
          Origin: 'https://h5-bj.ninebot.com',
          Referer: 'https://h5-bj.ninebot.com/',
          from_platform_1: '1',
          language: 'zh',
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 15_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Segway v6 C 609033420'
        }
      };
      if (payload) options.body = JSON.stringify(payload);

      try {
        $httpClient[method](options, (error, response, body) => {
          const status = Number(response && (response.statusCode || response.status));
          if (status === 401 || status === 403) {
            reject(new Error(`${label}授权失败（HTTP ${status}），请重新抓取凭证。`));
            return;
          }
          if (Number.isInteger(status) && status >= 100 && (status < 200 || status >= 300)) {
            reject(new Error(`${label}失败（HTTP ${status}）。`));
            return;
          }
          if (error || !Number.isInteger(status) || status < 200) {
            reject(new Error(`${label}时连接失败或超时。`));
            return;
          }
          let data;
          try {
            data = JSON.parse(body);
          } catch (_) {
            reject(new Error(`${label}返回了无效数据。`));
            return;
          }
          if (!data || ![0, '0'].includes(data.code)) {
            const code =
              data && /^-?\d{1,9}$/.test(String(data.code)) ? `（业务码 ${data.code}）` : '';
            reject(new Error(`${label}失败${code}。`));
            return;
          }
          resolve(data.data);
        });
      } catch (_) {
        reject(new Error(`无法发起${label}请求。`));
      }
    });
  }

  async function readStatus(account) {
    const data = await apiRequest(account, 'get', `status?t=${Date.now()}`, '查询签到状态');
    const status = data && data.currentSignStatus;
    if (![0, 1, '0', '1'].includes(status)) throw new Error('返回的签到状态无法识别。');
    const days = data.consecutiveDays;
    return {
      signed: status === 1 || status === '1',
      days: /^\d{1,9}$/.test(String(days)) ? String(days) : ''
    };
  }

  function signedMessage(message, state) {
    return state.days ? `${message}\n连续签到 ${state.days} 天。` : message;
  }

  async function signAccount(account) {
    const initial = await readStatus(account);
    if (initial.signed) return signedMessage('今日已签到。', initial);

    let signError;
    try {
      await apiRequest(account, 'post', 'sign', '提交签到', {
        deviceId: account.deviceId
      });
    } catch (error) {
      signError = error;
    }

    let finalStatus;
    try {
      finalStatus = await readStatus(account);
    } catch (error) {
      throw new Error(
        signError
          ? `${signError.message}\n${error.message}`
          : `已提交签到，但未能确认结果。\n${error.message}`
      );
    }
    if (finalStatus.signed) return signedMessage('今日签到已确认。', finalStatus);
    if (signError) throw signError;
    throw new Error('已提交签到，服务端仍显示今日未签到。');
  }

  async function runSignIn() {
    const accounts = Object.entries(readAccounts());
    if (!accounts.length) {
      notify('签到异常', '请先启用抓取凭证，并在九号出行 App 打开签到页。');
      return;
    }

    for (const [uid, storedAccount] of accounts) {
      if (!isValidUid(uid)) {
        notify('签到异常', '本地存储中发现无效 UID，已跳过该账号。', uid);
        continue;
      }

      if (
        !storedAccount ||
        !isValidCredential(storedAccount.authorization) ||
        !isValidCredential(storedAccount.deviceId)
      ) {
        notify('签到异常', '本地凭证不完整或格式无效，请重新抓取。', uid);
        continue;
      }

      const account = {
        authorization: storedAccount.authorization.trim(),
        deviceId: storedAccount.deviceId.trim()
      };

      try {
        const delaySeconds = Math.floor(Math.random() * 5) + 1;
        console.log(`[${TITLE}] UID[${uid}]：随机等待 ${delaySeconds} 秒后开始签到。`);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        notify('签到成功', await signAccount(account), uid);
      } catch (error) {
        notify('签到异常', error.message, uid);
      }
    }
  }

  if (typeof $request !== 'undefined' && $request) {
    try {
      capture($request);
    } catch (_) {
      notify('获取失败', '无法读取签到页请求。');
    } finally {
      $done({});
    }
  } else {
    runSignIn()
      .catch(() => notify('签到异常', '无法读取本地凭证，请重新抓取。'))
      .finally(() => $done());
  }
})();
