# Cloudflare Pages Mock 部署说明

这是 `com.jerry.live.dszb` APP 的 mock 接口数据。

## 文件结构

```
/                    仓库根目录（Cloudflare Pages 部署入口）
├── dszb.gz           频道列表（gzip 压缩的 JSON）
├── api/
│   ├── check.json    设备校验
│   ├── getTime.json  服务器时间
│   └── loginNew.json 用户登录
├── config/
│   ├── dszb/
│   │   └── config3.json  APP 配置
│   └── userVip.json  海外用户配置
└── v1/
    └── gwpd2.json    购物频道（空）
```

## 访问示例

- https://live-source-b8i.pages.dev/dszb.gz
- https://live-source-b8i.pages.dev/api/getTime.json
- https://live-source-b8i.pages.dev/api/check.json
- https://live-source-b8i.pages.dev/api/loginNew.json
- https://live-source-b8i.pages.dev/config/dszb/config3.json
- https://live-source-b8i.pages.dev/config/userVip.json
- https://live-source-b8i.pages.dev/v1/gwpd2.json
