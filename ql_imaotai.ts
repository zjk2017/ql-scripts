/**
 I茅台预约 v1.0

 cron: 20 9 * * *
 const $ = new Env("I茅台预约");

 执行 `tsx src/active/imaotai.ts -m <手机号>`，可以输入收到的验证码，并请求返回 token，并在当前文件夹下保存
 自行抓包并在 lzwme_ql_config.json 文件中配置 config 信息
 */

import { Request, dateFormat, assign, md5, aesEncrypt, formatToUuid } from '@lzwme/fe-utils';
import { getGeoByGD, getLiteStorage, sendNotify } from './utils';
import { program } from 'commander';
import { IncomingHttpHeaders } from 'http';
import { homedir, hostname } from 'os';

// const itemMap = {
//   10213: '贵州茅台酒（癸卯兔年）',
//   10056: '茅台1935',
//   2478: '贵州茅台酒（珍品）',
//   10214: '贵州茅台酒（癸卯兔年）x2',
// };
const config = {
  AMAP_KEY: '', // 高德地图 key，用于命令行方式登录获取经纬度，可以不用
  appVersion: '1.5.3', // APP 版本，可以不写，会尝试自动获取
  type: '预约类型。为 max 时查找当前城市最大投放量的店铺预约',
  user: [
    {
      mobile: '',
      itemCodes: ['10213', '10214'], // 要预约的类型
      province: 'xx省',
      city: 'xx市',
      // 以下项可抓包获取
      lng: '', //经度
      lat: '', // 纬度
      deviceId: formatToUuid(md5(hostname() + homedir()))[0].toUpperCase(), // MT-Device-ID
      token: '', // MT-Token
      tokenWap: '', // MT-Token-Wap
      header: {
        // 自定义 header，抓包自己的 header，避免被识别为多设备登录的可能性
        h5: {
          'Client-User-Agent': 'iOS;15.0.1;Apple;iPhone 12 ProMax',
        } as IncomingHttpHeaders,
        app: {
          'User-Agent': 'iOS;16.0.1;Apple;iPhone 14 ProMax',
        } as IncomingHttpHeaders,
      },
    },
  ],
};
const defautUser = config.user[0];
config.user[0] = assign({} as any, defautUser);

const stor = getLiteStorage('I茅台预约');
const req = new Request('', {
  'MT-User-Tag': '0',
  'Accept-Language': 'zh-Hans-CN;q=1, en-CN;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  userId: '1',
  'mt-token': '2',
});
const mt_r = 'clips_OlU6TmFRag5rCXwbNAQ/Tz1SKlN8THcecBp/';
const time_keys = new Date(`${dateFormat('yyyy-MM-dd')}T00:00:00`).getTime();
const AES_KEY = 'qbhajinldepmucsonaaaccgypwuvcjaa';
const AES_IV = '2018534749963515';
const SALT = '2af72f100c356273d46284f6fd1dfc08';
const imaotai = {
  debug: process.env.DEBUG === '1',
  /** 所有的店铺信息 */
  mall: {} as {
    [shopId: string]: {
      lat: number;
      lng: number;
      city: number;
      cityName: string;
      province: number;
      fullAddress: string;
      layaway: boolean;
      provinceName: string;
      name: string;
    };
  },
  user: { ...defautUser },
  async getMap() {
    const res = await req.get('https://static.moutai519.com.cn/mt-backend/xhr/front/mall/resource/get');
    const r = await req.get(res.data.data.mtshops_pc.url, {}, { 'content-type': 'application/json' });
    this.mall = r.data;
  },
  async mtAdd(itemId: string, shopId: string, sessionId: string, userId: string) {
    const MT_K = Date.now();
    const { data: mtv } = await req.get<string>(
      `http://82.157.10.108:8086/get_mtv?DeviceID=${this.user.deviceId}&MTk=${MT_K}&version=${config.appVersion}&key=yaohuo`
    );
    const headers = {
      ...this.getHeaders({}),
      'MT-K': MT_K,
      'MT-V': mtv,
    };
    const d = { itemInfoList: [{ count: 1, itemId }], sessionId: sessionId, userId: String(userId), shopId: String(shopId) };
    const actParam = aesEncrypt(JSON.stringify(d), AES_KEY, 'aes-256-cbc', AES_IV).toString('base64');
    const params = { ...d, actParam };
    const r = await req.post('https://app.moutai519.com.cn/xhr/front/mall/reservation/add', params, headers);
    if (this.debug) console.log('[mtAdd]', r.data);
    if (r.data.code == 2000) return r.data?.data?.successDesc || '未知';
    return '申购失败:' + (r.data.message || JSON.stringify(r.data));
  },
  async getSessionId() {
    const headers = {
      'mt-user-tag': '0',
      'mt-network-type': 'WIFI',
      'mt-request-id': Date.now(),
      'mt-r': mt_r,
    };
    const r = await req.get<{ data: { itemList: any[]; sessionId: string } }>(
      'https://static.moutai519.com.cn/mt-backend/xhr/front/mall/index/session/get/' + time_keys,
      {},
      headers
    );
    if (!r.data.data?.sessionId) console.log('获取 sessionId 失败', JSON.stringify(r.data));
    return r.data?.data || {};
  },
  // 查询投放量，返回要预约的店铺 id
  async getShopItem(sessionId: string, itemId: string, province: string, city: string) {
    const headers = {
      'mt-user-tag': '0',
      'mt-network-type': 'WIFI',
      'mt-request-id': Date.now(),
      'mt-r': mt_r,
    };
    // 2.查询所在省市的投放产品和数量
    // https://static.moutai519.com.cn/mt-backend/xhr/front/mall/shop/list/slim/v3/837/%E9%87%8D%E5%BA%86%E5%B8%82/10213/1701100800000
    type Item = { count: number; itemId: string; ownerName: string; maxReserveCount: number; inventory: number };
    const r = await req.get<{ code: number; data: { shops: { shopId: string; items: Item[] }[]; validTime: number; items: any[] } }>(
      `https://static.moutai519.com.cn/mt-backend/xhr/front/mall/shop/list/slim/v3/${sessionId}/${province}/${itemId}/${time_keys}`,
      {},
      headers
    );
    const data = r.data.data;
    const selectedShopItem: { shopId: string; item?: Item } = { shopId: '' };

    for (const shop of data.shops) {
      const shopInfo = this.mall[shop.shopId];
      const item = shop.items.find((d) => d.itemId == itemId);

      if (!item || shopInfo?.cityName !== city) continue;

      if (!selectedShopItem.item || selectedShopItem.item.inventory < item.inventory!) {
        selectedShopItem.shopId = shop.shopId;
        selectedShopItem.item = item;
        if (config.type !== 'max') break; // 不是 max，第一个就是最近的
      }
    }

    if (this.debug) console.log('[selectedShopItem]', selectedShopItem);
    return selectedShopItem;
  },
  getHeaders(cheaders: IncomingHttpHeaders = {}, type: 'h5' | 'app' = 'app') {
    const header: IncomingHttpHeaders = { 'MT-R': mt_r };

    if (type === 'app') {
      Object.assign(header, {
        Accept: '*/*',
        'MT-Bundle-ID': 'com.moutai.mall',
        'content-type': 'application/json',
        'MT-Network-Type': 'WIFI',
        'MT-User-Tag': '0',
        'MT-Info': '028e7f96f6369cafe1d105579c5b9377',
        'MT-Device-ID': this.user.deviceId,
        'MT-Lat': this.user.lat,
        'MT-Lng': this.user.lng,
        ...this.user.header.app,
      });
    } else {
      Object.assign(header, {
        Connection: 'keep-alive',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        YX_SUPPORT_WEBP: '1',
        'MT-Device-ID-Wap': this.user.deviceId,
        ...this.user.header.h5,
      });
    }

    Object.assign(header, {
      'MT-Request-ID': `${Date.now()}${Math.ceil(Math.random() * (999999999 - 1111111) + 1111111)}`,
    });

    return Object.assign(header, cheaders);
  },
  async getUserId(): Promise<{ userName: string; userId: string; mobile: string }> {
    const headers = this.getHeaders();
    const { data: r } = await req.get('https://app.moutai519.com.cn/xhr/front/user/info', {}, headers);

    if (r.code != 2000) {
      if (r.data?.version && r.data.version != config.appVersion) {
        console.log('不是最新的版本号', config.appVersion, r.data);
        config.appVersion = r.data.version;
        stor.save(config);
        return this.getUserId() as any;
      }
      console.log('userinfo:', r);
    }
    return r.data || {}; // userName, userId, mobile
  },
  async getAppVersion(isSave = true) {
    const { data: html } = await req.get<string>(
      'https://apps.apple.com/cn/app/i%E8%8C%85%E5%8F%B0/id1600482450',
      {},
      { 'content-type': 'text/html' }
    );
    const r = String(html).match(/whats-new__latest__version.+(\d+\.\d+\.\d+)/);

    if (r && r[1] !== config.appVersion) {
      console.log(`获取到新版本：${config.appVersion} => ${r[1]}`);
      config.appVersion = r[1];
      if (isSave) stor.save(config);
    }
    req.setHeaders({ 'MT-APP-Version': config.appVersion });
  },
  signature(data: Record<string, unknown>, timestamp = Date.now().toString()) {
    const keys = Object.keys(data).sort();
    const text = SALT + keys.map((k) => data[k]).join('') + timestamp;
    return md5(text);
  },
  /** 获取手机验证码 */
  async getPhoneCode(mobile: string | number, timestamp = Date.now().toString()) {
    const params: Record<string, any> = { mobile };
    params.md5 = this.signature(params, timestamp);
    params.timestamp = timestamp;
    params['MT-APP-Version'] = config.appVersion;
    const headers = this.getHeaders({ 'mt-lat': this.user.lat, 'mt-lng': this.user.lng });
    const { data } = await req.post('https://app.moutai519.com.cn/xhr/front/user/register/vcode', params, headers);
    if (+data.code !== 2000) console.log(`发送验证码异常【${mobile}】：`, data);
    return data;
  },
  /** 登录 */
  async login(mobile: string | number, vCode: string) {
    const params: Record<string, any> = {
      mobile,
      vCode,
      ydToken: '',
      ydLogId: '',
    };
    const timestamp = Date.now().toString();
    params.md5 = this.signature(params, timestamp);
    params.timestamp = timestamp;
    params.MT_APP_Version = config.appVersion;

    const { data } = await req.post<{
      code: number;
      data: { token: string; userId: number; cookie: string; did: string; verifyStatus: number; idCode: string; birthday: string };
    }>('https://app.moutai519.com.cn/xhr/front/user/register/login', params, this.getHeaders());
    console.log('\n', data.data?.token ? '[login]:' : '登录失败，请重试：', data);
    if (data.data?.verifyStatus !== 1) console.warn('请注意，该账号尚未实名认证');
    return data.data;
  },
  // 领取耐力
  async getUserEnergyAward() {
    const headers = this.getHeaders(
      {
        Referer: 'https://h5.moutai519.com.cn/gux/game/main?appConfig=2_1_2',
        cookie: [
          `MT-Device-ID-Wap=${this.user.deviceId}`,
          `MT-Token-Wap='${this.user.tokenWap || this.user.token}`,
          'YX_SUPPORT_WEBP=1',
        ].join(';'),
      },
      'h5'
    );
    const r = await req.post('https://h5.moutai519.com.cn/game/isolationPage/getUserEnergyAward', {}, headers);
    console.log('领取耐力值：', r.data?.message);
    return r.data.message || '领取奖励成功';
  },
  async start(inputData = config) {
    const msgList = [];
    let userCount = 0;
    try {
      await this.getAppVersion();
      await this.getMap();

      for (const user of inputData.user) {
        userCount++;

        this.user = assign({} as any, defautUser, user, {
          header: {
            app: {
              'MT-Token': user.token,
            },
            h5: {
              'MT-Token-Wap': user.tokenWap,
            },
          },
        } as Partial<typeof defautUser>);

        const { userName, userId, mobile } = await this.getUserId();
        if (!userId) {
          msgList.push(`第 ${userCount} 个用户 token 失效，请重新登录`);
          continue;
        }

        req.setHeaders({ userId });
        msgList.push(`第 ${userCount} 个用户【${userName}_${mobile}】开始任务-------------`);
        const sessionInfo = await this.getSessionId();
        if (!sessionInfo.sessionId) {
          msgList.push(`获取 sessionId 失败: ${JSON.stringify(sessionInfo)}`);
        } else {
          for (const item of sessionInfo.itemList) {
            if (user.itemCodes.includes(item.itemCode)) {
              const shop = await this.getShopItem(sessionInfo.sessionId, item.itemCode, this.user.province, this.user.city);
              if (shop.shopId) {
                const shopInfo = this.mall[shop.shopId];
                const r = await this.mtAdd(item.itemCode, shop.shopId, sessionInfo.sessionId, userId);
                msgList.push(`选中店铺：【${shopInfo.name}】【${shopInfo.fullAddress}】【投放量：${shop.item!.inventory}】`);
                msgList.push(`${item.itemCode}_${item.title}------${r}`);
              } else {
                msgList.push(`【${item.itemCode}_${item.title}】未获取到可预约的店铺，未能预约`);
              }
            }
          }
          const awardMsg = await this.getUserEnergyAward();
          msgList.push(`领取来耐力值：${awardMsg}`);
        }
      }
    } catch (err) {
      console.log(err);
      msgList.push((err as Error).message || JSON.stringify(err));
    }

    await sendNotify('I茅台预约', msgList.join('\n'));
  },
};

async function promptLogin(opts: { login: boolean; force?: boolean }) {
  const { prompt } = (await import('enquirer')).default;
  const inputData = {
    AMAP_KEY: process.env.AMAP_KEY || config.AMAP_KEY,
    vcode: '',
  };
  const { mobile } = await prompt<{ mobile: string }>([
    {
      type: 'input',
      name: 'mobile',
      message: '请输入登录使用的 11 位手机号码',
      initial: '',
      validate: (mobile) => /\d{11}/.test(mobile) || '请输入正确的11位手机号码',
    },
  ]);

  const existUser = config.user.find((d) => d.mobile === mobile);
  if (existUser) imaotai.user = existUser;
  imaotai.user.mobile = mobile;

  if (!imaotai.user.lat || opts.force) {
    if (!inputData.AMAP_KEY) {
      const { AMAP_KEY } = await prompt<{ AMAP_KEY: string }>({
        type: 'input',
        name: 'AMAP_KEY',
        initial: config.AMAP_KEY,
        message: '请输入高德地图 KEY （用于获取经纬度，没有则直接回车下一步）',
      });
      if (AMAP_KEY.length > 20) config.AMAP_KEY = inputData.AMAP_KEY = AMAP_KEY;
    }

    if (inputData.AMAP_KEY) {
      const { address } = await prompt<{ address: string }>([
        {
          type: 'input',
          name: 'address',
          message: '请输入您当前的位置或要预约的地点（如：北京市朝阳区xxx路xx小区）',
          initial: '',
          validate: (address) => address.length > 4 || '输入字符太少',
        },
      ]);
      const list = await getGeoByGD(address, inputData.AMAP_KEY);
      const { idx } = await prompt<{ idx: string }>({
        type: 'select',
        name: 'idx',
        message: '请选择最近的一个位置',
        choices: list.map((d) => ({
          name: d.formatted_address,
          message: `地址：${d.formatted_address}, 定位：${d.location}`,
        })),
      });
      const item = list.find((d) => d.formatted_address === idx) || list[0];
      const [lng, lat] = item.location.split(',');
      const t = {
        province: item.province,
        city: item.city,
        lat: +lat < +lng ? lat : lng,
        lng: +lat > +lng ? lat : lng,
      };
      assign(imaotai.user, t);
    } else {
      await prompt([
        {
          type: 'input',
          name: 'province',
          message: '请输入预约的省份（如广东省）',
          initial: imaotai.user.province,
          validate: async (province) => {
            imaotai.user.province = province.trim();
            return /省|市$/.test(province.trim()) || '输入格式不正确';
          },
        },
        {
          type: 'input',
          name: 'city',
          message: '请输入预约的城市（如广州市）',
          initial: imaotai.user.city,
          validate: async (city) => {
            imaotai.user.city = city.trim();
            return /市$/.test(city.trim()) || '输入格式不正确';
          },
        },
        {
          type: 'input',
          name: 'location',
          message: '请输入预约位置经纬度，逗号分割',
          validate: async (location) => {
            if (!/\d+.\d+,\d+.\d+/.test(location.trim())) return '输入格式不正确';
            const [lng, lat] = location.split(',');
            imaotai.user.lat = +lat < +lng ? lat : lng;
            imaotai.user.lng = +lat > +lng ? lat : lng;

            return true;
          },
        },
      ]);
    }
  }

  const r = await imaotai.getPhoneCode(mobile);
  if (r.code != 2000) {
    console.error('发送验证码错误', r);
    return;
  }

  await prompt<typeof inputData>([
    {
      type: 'input',
      name: 'vcode',
      message: '请输入接收到的验证码',
      validate: async (vcode) => {
        if (!/\d+/.test(vcode)) return false;
        const data = await imaotai.login(mobile, vcode);
        if (data?.token) {
          inputData.vcode = vcode;
          imaotai.user.token = data.token;
          imaotai.user.tokenWap = data.cookie || '';
        }
        return Boolean(data?.token);
      },
    },
  ]);

  if (!existUser) config.user.push(imaotai.user);

  // @ts-ignore
  Object.keys(info).forEach((k) => !info[k] && delete info[k]);
  stor.save(config);

  console.log(`获取到token信息：`, imaotai.user.token);
  // @ts-ignore
  console.log('请在配置文件中补充完善配置：', stor.options.filepath, '\n', JSON.stringify(imaotai.user, null, 2));
}

program
  .option('-l,--login', '是否位 login 模式，登录模式会写入到配置文件中供预约使用。默认为预约模式')
  .option('-f, --force', '强制模式')
  .option('-d, --debug', '调试模式')
  .action(async (opts: { login: boolean; force?: boolean; debug: boolean }) => {
    assign(config, stor.get());
    if (opts.debug) imaotai.debug = opts.debug;
    await imaotai.getAppVersion(false);
    return opts.login ? promptLogin(opts) : imaotai.start();
  })
  .parse();
