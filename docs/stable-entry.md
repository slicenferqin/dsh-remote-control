# 固定 HTTPS 入口 / Stable HTTPS entry

本指南使用保留示例域名 `dsh.example.com` 与 `relay.example.com`，所有大写绝对路径都是必须替换的占位符。示例不代表插件会自动创建服务器、账户、DNS 或证书。

**DSH、项目目录、服务商配置和 SSH 私钥留在本机。** VPS 仅运行受限 SSH 中继与 HTTPS 网关。本机仍使用 loopback DSH 监听，插件创建额外的配对桥接，并自动管理通往该桥接的 SSH 反向转发。

These examples use reserved example domains and absolute-path placeholders. DSH, projects, provider configuration, and SSH private keys remain on the local computer. The relay only terminates HTTPS and forwards traffic through the plugin's bridge.

## 1. 准备域名、服务器与本机 OpenSSH

- 将 `dsh.example.com` 的 DNS 指向你管理的 HTTPS 网关；SSH 的 `relay.example.com` 指向中继服务器。
- 在中继配置有效、自动续期的 TLS 证书，覆盖 `dsh.example.com`。公网 HTTPS 使用 443；SSH 端口按你的服务器配置开放。
- 服务器上的 `127.0.0.1:18380` 仅供同机 HTTPS 代理访问，不对公网开放。
- 在 DSH 电脑准备 OpenSSH、专用 SSH 私钥和已核实服务器指纹的 known-hosts 文件。插件使用非交互认证，不会弹出密码或首次信任确认。

若 SSH 服务和 HTTPS 网关不在同一服务器上，需要自行设计额外的受保护链路；以下示例假设它们同机。准备工作不会修改 DSH 默认监听或信任列表。

## 2. 使用专用、受限的 SSH 账户

由服务器管理员创建专用账户，例如 `dsh-relay`，只安装该用途的公钥。以下是服务端 OpenSSH 的 `Match` 配置示例；按服务器 OpenSSH 版本和已有配置验证后加载：

```sshdconfig
Match User dsh-relay
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    AllowStreamLocalForwarding no
    GatewayPorts no
    PermitListen 127.0.0.1:18380
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    MaxSessions 0
```

`MaxSessions 0` 禁止 shell、命令和子系统 session channel，仍允许本插件使用的 `ssh -NT` 转发。`AllowTcpForwarding remote` 限制为反向转发；`PermitListen` 限制监听地址及端口。确认所用 OpenSSH 支持这些指令。

该账户的 authorized-keys 记录还可叠加 key 级限制；以下整行只含公钥占位符：

```text
restrict,port-forwarding,permitlisten="127.0.0.1:18380" <DEDICATED_OPENSSH_PUBLIC_KEY>
```

把占位符替换成实际的 OpenSSH 公钥记录，私钥不上传中继。账户级规则仍限制 key 的转发方向与 session 权限。若采用其他账户策略，保留“只能监听指定回环端口、无交互 session、无 agent forwarding”的约束。先执行 `sshd -t` 验证配置，再按所在系统的方式加载服务配置。

## 3. 本机配置 SSH 别名

将下列内容写入本机专用 OpenSSH 配置文件。用你选择的真实绝对路径替换占位符，并通过可信渠道核对服务器 host key；不要为绕过连接问题关闭主机密钥验证。

```sshconfig
Host dsh-relay
    HostName relay.example.com
    User dsh-relay
    IdentityFile /ABSOLUTE/LOCAL/PATH/TO/dedicated_private_key
    UserKnownHostsFile /ABSOLUTE/LOCAL/PATH/TO/known_hosts
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    BatchMode yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    ForwardAgent no
    RequestTTY no
```

插件会读取选定配置，并自行传入 `-NT`、回环 `-R` 转发、连接保活和 `ExitOnForwardFailure` 等参数。**转发目标是插件创建的受控桥接端口**，不是直接公开 DSH Web 端口。不要再用另一个 SSH 进程占用同一服务端转发端口。

## 4. HTTPS 网关：保留来源校验并支持 WebSocket / 流

以下 Nginx 示例的 `map` 位于 `http` 上下文；`server` 同样置于该上下文。证书路径均为服务端占位符，先完成实际证书签发，再加载引用这些文件的 TLS 配置。

```nginx
map $http_upgrade $dsh_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name dsh.example.com;

    ssl_certificate     /ABSOLUTE/SERVER/PATH/TO/fullchain.pem;
    ssl_certificate_key /ABSOLUTE/SERVER/PATH/TO/private_key.pem;

    location / {
        proxy_pass http://127.0.0.1:18380;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $dsh_connection_upgrade;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_redirect off;
    }
}
```

原样传递 `Host` 和 `Origin`，让桥接核对精确 authority；不要把任意请求的 Host / Origin 强制改写成可信来源。WebSocket 需要 Upgrade 转发，SSE/长响应需要关闭缓冲。网关不应缓存配对、刷新、业务响应或健康接口，也不应注入认证 Cookie、DSH token 或其他绕过桥接的凭证。

使用 `nginx -t` 验证配置后再按服务器方式加载。TLS 证书、监听端口和 DNS 正确时，插件才能通过实际公网 HTTPS 健康探测；仅 SSH 成功登录不算入口就绪。

## 5. 配置本机插件

下列是插件配置字段示例，不是完整的 Cordis composition。请在本机 DSH 插件配置中设置这些字段；完整字段及范围见[中文 README](../README.md#配置)和[英文 README](../README.en.md#configuration)。

```yaml
tunnelMode: ssh
publicOrigin: https://dsh.example.com
sshPath: ssh
sshTarget: dsh-relay
sshConfigPath: /ABSOLUTE/LOCAL/PATH/TO/ssh-config
sshRemotePort: 18380
persistDevices: true
deviceStorePath: /ABSOLUTE/LOCAL/PATH/TO/private-state/devices.json
autoStart: false
```

`publicOrigin` 只接受合法 HTTPS origin，使用默认 443，不带 userinfo、业务路径、query 或 fragment。`sshTarget` 推荐使用上一步配置的 Host 别名；`sshConfigPath` 可省略为空字符串，此时 OpenSSH 使用其默认配置。

**`deviceStorePath` 必须是本机绝对文件路径。** 示例中的 `/ABSOLUTE/LOCAL/PATH/TO/...` 需要整体替换；它不是 profile 的相对路径，不展开 `~`，也不猜测 HOME。Windows 使用所在系统合法的绝对路径，并按所用配置格式转义。不同 DSH 实例使用不同状态文件，当前 store 仅支持单写入者。

新建状态目录使用 `0700`，文件以原子方式写入并保持 `0600`。文件应由运行 DSH 的用户拥有；不安全权限、坏数据、目标文件符号链接/硬链接，以及不安全的直接父目录会导致拒绝恢复。状态错误需要本机处理，插件不会忽略错误并继续签发凭证。

## 6. 首次配对、重启与主动关闭

先保持 `autoStart: false`，在已认证的本机 **设置 → 远程控制** 中开启入口。等状态为在线后，用手机扫描本机显示的二维码，确认设备名称并提交。保存 `https://dsh.example.com/` 作为日常入口。

从 Quick 域名切换到固定域名时，每台设备需要在新域名配对一次。以后在同域名、未到期且未撤销的条件下，持久 store 可恢复设备刷新授权。受控重载或正常重启保留设备 ID；旧 access 不恢复，下一次请求使用有效 refresh 重新兑换当前 Host 的 Core Cookie。

若希望 DSH 启动时恢复入口，可由用户显式设置 `autoStart: true`。这是自动开启授权，空 store 的首次启动也可能开启入口。持久记录的 Off 优先：主动关闭入口会撤销所有设备、记录 Off 并停止重连，之后重启不会自动打开。用户再次在本机开启后，才恢复开启意图。关闭持久化时，Off 不会跨进程记忆。

启用入口和签发二维码保持本机用户操作。`remote_control` agent 工具可读取不含凭证的状态、重命名、撤销或关闭，不能启用入口或创建配对码。

本机文件只存当前 refresh hash、到期时间、设备元数据和开关意图，不存 raw refresh/access、Core Cookie、DSH 启动 token 或配对码。刷新轮换的 120 秒宽限结果只在内存中；若已写入新轮换但浏览器未收到或应用 Cookie 时进程崩溃，需要重新配对。

## 7. 健康状态与排查

入口保持 enabled 时，`connection.status` 仍可能是 `checking`、`reconnecting` 或 `offline`。`online` 表示最近一次公网探测已到达**当前**桥接；不是持续可用保证。SSH 会重连并保留有效设备授权，电脑仍必须唤醒、联网并运行 DSH。

公网健康检查可使用不带任何凭证的请求：

```sh
curl --fail --include https://dsh.example.com/__dsh_remote_health
```

预期响应形态：

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json; charset=utf-8

{"ok":true,"service":"dsh-remote-control","entryId":"<current-bridge-id>"}
```

响应不设置 Cookie，不含设备数量、文件路径、配对数据或凭证。不要在 Nginx 放静态 health JSON 冒充此接口；SSH provider 同时确认它拥有的反向转发成功，以及 `entryId` 与当前本机桥接一致。普通公开 health 查询只能看到 service marker，不能获得 DSH 权限。

| 现象 | 检查方向 |
| --- | --- |
| 启动超时 / `SSH_FORWARD_FAILED` | 专用账户的 PermitListen、回环端口是否被占用、端口配置是否一致。 |
| `SSH_AUTH_FAILED` / `SSH_HOST_KEY_FAILED` | 本机专用配置、私钥可用性、账户公钥及已核实的服务器指纹。 |
| HTTP 502 / health 不可达 | SSH 是否连接、Nginx upstream 是否为同一回环端口、DNS/TLS 是否到达此网关。 |
| health 属于其他 entry | 残留或错误的反向转发、错误的 upstream、缓存或虚假的静态响应。 |
| 页面可开但 WS / 流断开 | Upgrade 头、HTTP/1.1、缓冲和代理超时配置。 |
| 健康在线但配对凭证不可用 | 是否换了域名/浏览器、清过 Cookie、授权过期或被主动撤销。 |

## 8. 证书签发与续期

可使用 Lego 或其他 ACME 客户端，按实际网络与 DNS 条件选择挑战方式，不能假设某一种方式处处可用：

| 方式 | 适用前提与维护要求 |
| --- | --- |
| DNS-01 | 能为目标域名自动更新验证记录；DNS API 凭证按所用 provider 的要求单独保护。公网 80/443 的转发不决定该挑战能否成功。 |
| HTTP-01 | CA 必须能通过公网 80 访问正确的 challenge 响应。检查防火墙、CDN、重定向及 webroot/路由是否满足条件，再选择此方式。 |
| TLS-ALPN-01 | 公网 443 必须到达支持该挑战 ALPN 的响应器。若 standalone 客户端需要临时停止 Nginx，占用 443 的操作会导致入口中断。 |

若使用需要接管 443 的 TLS-ALPN 维护，**安排维护窗口和自动恢复**：限定作业最长时间，记录原有服务状态，并在挑战成功、失败或中断后恢复原有 HTTPS 服务，再检查公网 health。该流程有停机窗口，不能称为无停机续期。CDN、额外 TLS 终止层或端口转发可能改变挑战条件。

成功续期后验证证书链与到期时间，再按网关要求重载证书。配置并测试定时任务的失败报告与恢复流程；不要只依赖首次手工签发成功。证书客户端的账户文件和私钥属于服务器运维状态，与本机设备 store 分开保存。

Certificate maintenance depends on the actual DNS and network path. DNS-01, HTTP-01 and TLS-ALPN-01 each have prerequisites. A standalone TLS-ALPN renewal that takes port 443 away from the gateway needs a maintenance window and guaranteed service restoration, including on failure; it is not a zero-downtime procedure.

## 范围与限制 / Scope

HTTPS 网关位于信任范围内，可以看到它终止的 HTTP 流量。配对设备取得 DSH Host 的 owner 能力；只配对可信浏览器。桥接继续使用 `HttpOnly; Secure; SameSite=Strict` Cookie、精确 Host/Origin 校验、被阻断的远程管理与 `/connect` 路径，以及现有 Core 认证。固定域名不会扩大 DSH 的监听地址，也不会把本机文件或服务商配置迁移到中继。

The relay is within the TLS trust boundary. Paired browsers receive DSH owner capabilities. A fixed URL does not make a sleeping or stopped local Host available, and no project/provider data needs to be hosted on the relay.
