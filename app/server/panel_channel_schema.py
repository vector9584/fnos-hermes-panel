"""Only fields verified against the installed 0.21.149 gateway/adapters.

The catalog describes storage and editor controls, never imports an adapter or
runs dependency checks. Unknown/retired stored fields remain untouched.
"""
def field(key,label,env=None,path=None,*,secret=False,kind='text',default='',choices=None,aliases=(),required=False):
 result={'key':key,'label':label,'env':env,'path':path,'secret':secret,'kind':kind,'default':default,'aliases':list(aliases),'required':required}
 if choices:result['choices']=choices
 return result

def credential(key,label,env,path=None,**options):return field(key,label,env,path,**options)
def behavior(key,label,env=None,*,default=True,path=None,**options):return field(key,label,env,path or key,kind='bool',default=default,**options)
def policy(key,label,env=None,default='pairing'):return field(key,label,env,'extra.'+key,kind='select',default=default,choices=['pairing','allowlist','open','disabled'],aliases=[key])
def channel(name,fields,*,qr=False,required=(),alternative=()):return {'name':name,'fields':fields,'qr':qr,'required':list(required),'alternative':list(alternative)}
C=credential;F=field;B=behavior
CATALOG={
 'telegram':channel('Telegram',[
  C('token','Bot Token','TELEGRAM_BOT_TOKEN','token',secret=True),C('proxy','代理地址','TELEGRAM_PROXY',None,aliases=['proxy_url'],secret=True),
  B('require_mention','群聊需要提及机器人','TELEGRAM_REQUIRE_MENTION',default=False),B('reactions','消息反应','TELEGRAM_REACTIONS',default=False),
  F('free_response_chats','自由回复的会话 ID','TELEGRAM_FREE_RESPONSE_CHATS','free_response_chats',kind='list'),
  F('allowed_users','允许的用户 ID','TELEGRAM_ALLOWED_USERS','extra.allow_from',kind='list',aliases=['allow_from']),
 ],qr=True,required=['token']),
 'discord':channel('Discord',[
  C('token','Bot Token','DISCORD_BOT_TOKEN','token',secret=True),C('proxy','代理地址','DISCORD_PROXY',secret=True),
  B('require_mention','频道需要提及机器人','DISCORD_REQUIRE_MENTION'),B('auto_thread','自动创建线程','DISCORD_AUTO_THREAD',default=True),B('reactions','消息反应','DISCORD_REACTIONS'),
  F('free_response_channels','自由回复的频道 ID','DISCORD_FREE_RESPONSE_CHANNELS','extra.free_response_channels',kind='list',aliases=['free_response_channels']),
  F('allowed_channels','允许的频道 ID','DISCORD_ALLOWED_CHANNELS','extra.allowed_channels',kind='list',aliases=['allowed_channels']),
  F('ignored_channels','忽略的频道 ID','DISCORD_IGNORED_CHANNELS','extra.ignored_channels',kind='list',aliases=['ignored_channels']),
  F('allowed_users','允许的用户 ID','DISCORD_ALLOWED_USERS','extra.allow_from',kind='list',aliases=['allow_from']),
 ],required=['token']),
 'slack':channel('Slack',[
  C('token','Bot Token','SLACK_BOT_TOKEN','token',secret=True),C('app_token','App Token','SLACK_APP_TOKEN',secret=True),
  B('require_mention','频道需要提及机器人','SLACK_REQUIRE_MENTION'),B('allow_bots','接收机器人消息','SLACK_ALLOW_BOTS',default=False),
  F('free_response_channels','自由回复的频道 ID','SLACK_FREE_RESPONSE_CHANNELS','free_response_channels',kind='list'),
  F('allowed_users','允许的用户 ID','SLACK_ALLOWED_USERS',kind='list'),
 ],required=['token','app_token']),
 'whatsapp':channel('WhatsApp',[
  F('mode','号码用途','WHATSAPP_MODE',kind='select',default='self-chat',choices=['self-chat','bot']),
  policy('dm_policy','私信策略','WHATSAPP_DM_POLICY'),policy('group_policy','群聊策略','WHATSAPP_GROUP_POLICY'),
  F('allowed_users','允许的号码','WHATSAPP_ALLOWED_USERS','extra.allow_from',kind='list',aliases=['allow_from']),
 ]),
 'matrix':channel('Matrix',[
  C('token','Access Token','MATRIX_ACCESS_TOKEN','token',secret=True),C('password','账户密码','MATRIX_PASSWORD','extra.password',secret=True),
  F('homeserver','Homeserver','MATRIX_HOMESERVER','extra.homeserver'),F('user_id','用户 ID','MATRIX_USER_ID','extra.user_id'),
  B('require_mention','房间需要提及机器人','MATRIX_REQUIRE_MENTION'),B('auto_thread','自动创建线程','MATRIX_AUTO_THREAD',default=True),
  B('dm_mention_threads','私信使用提及线程','MATRIX_DM_MENTION_THREADS',default=False,path='dm_mention_threads'),
  F('free_response_rooms','自由回复的房间 ID','MATRIX_FREE_RESPONSE_ROOMS','free_response_rooms',kind='list'),
 ],required=['homeserver'],alternative=['token','password']),
 'feishu':channel('飞书',[
  C('app_id','App ID','FEISHU_APP_ID','extra.app_id'),C('app_secret','App Secret','FEISHU_APP_SECRET','extra.app_secret',secret=True),
  C('encrypt_key','Encrypt Key','FEISHU_ENCRYPT_KEY','extra.encrypt_key',secret=True),C('verification_token','Verification Token','FEISHU_VERIFICATION_TOKEN','extra.verification_token',secret=True),
  F('domain','平台','FEISHU_DOMAIN','extra.domain',kind='select',default='feishu',choices=['feishu','lark']),
  F('connection_mode','连接方式','FEISHU_CONNECTION_MODE','extra.connection_mode',kind='select',default='websocket',choices=['websocket','webhook']),
  B('require_mention','群聊需要提及机器人','FEISHU_REQUIRE_MENTION',path='extra.require_mention',aliases=['require_mention']),
  F('allowed_users','允许的用户 ID','FEISHU_ALLOWED_USERS',kind='list'),
 ],required=['app_id','app_secret']),
 'dingtalk':channel('钉钉',[
  C('client_id','Client ID / AppKey','DINGTALK_CLIENT_ID','extra.client_id'),C('client_secret','Client Secret','DINGTALK_CLIENT_SECRET','extra.client_secret',secret=True),
  B('require_mention','群聊需要提及机器人','DINGTALK_REQUIRE_MENTION',default=False),F('allowed_users','允许的用户 ID','DINGTALK_ALLOWED_USERS','extra.allowed_users',kind='list',aliases=['allowed_users']),
  F('free_response_chats','自由回复的会话 ID','DINGTALK_FREE_RESPONSE_CHATS','free_response_chats',kind='list'),F('card_template_id','AI 卡片模板 ID',None,'extra.card_template_id'),
 ],required=['client_id','client_secret']),
 'qqbot':channel('QQ 机器人',[
  C('app_id','App ID','QQ_APP_ID','extra.app_id'),C('client_secret','Client Secret','QQ_CLIENT_SECRET','extra.client_secret',secret=True),
  C('stt_key','语音识别 API Key','QQ_STT_API_KEY','extra.stt.apiKey',secret=True),F('stt_url','语音识别服务地址','QQ_STT_BASE_URL','extra.stt.baseUrl'),F('stt_model','语音识别模型','QQ_STT_MODEL','extra.stt.model'),
  policy('dm_policy','私信策略'),policy('group_policy','群聊策略'),F('allow_from','私信白名单','QQ_ALLOWED_USERS','extra.allow_from',kind='list',aliases=['allow_from']),F('group_allow_from','群聊白名单','QQ_GROUP_ALLOWED_USERS','extra.group_allow_from',kind='list',aliases=['group_allow_from']),
  B('markdown_support','发送 Markdown 消息',path='extra.markdown_support'),
 ],qr=True,required=['app_id','client_secret']),
 'weixin':channel('微信',[
  C('token','Token','WEIXIN_TOKEN','token',secret=True),C('account_id','Account ID','WEIXIN_ACCOUNT_ID','extra.account_id'),
  F('base_url','API 地址','WEIXIN_BASE_URL','extra.base_url'),F('cdn_base_url','CDN 地址','WEIXIN_CDN_BASE_URL','extra.cdn_base_url'),
  policy('dm_policy','私信策略','WEIXIN_DM_POLICY'),policy('group_policy','群聊策略','WEIXIN_GROUP_POLICY','disabled'),
  F('allow_from','私信白名单','WEIXIN_ALLOWED_USERS','extra.allow_from',kind='list',aliases=['allow_from']),F('group_allow_from','群聊白名单','WEIXIN_GROUP_ALLOWED_USERS','extra.group_allow_from',kind='list',aliases=['group_allow_from']),
  B('split_multiline_messages','多行回复拆分发送','WEIXIN_SPLIT_MULTILINE_MESSAGES',default=False,path='extra.split_multiline_messages'),
 ],qr=True,required=['token','account_id']),
 'wecom':channel('企业微信',[
  C('bot_id','Bot ID','WECOM_BOT_ID','extra.bot_id'),C('secret','Secret','WECOM_SECRET','extra.secret',secret=True),
  F('websocket_url','WebSocket 地址','WECOM_WEBSOCKET_URL','extra.websocket_url'),policy('dm_policy','私信策略','WECOM_DM_POLICY'),policy('group_policy','群聊策略','WECOM_GROUP_POLICY'),F('allow_from','私信白名单','WECOM_ALLOWED_USERS','extra.allow_from',kind='list'),F('group_allow_from','群聊白名单',None,'extra.group_allow_from',kind='list'),
 ],qr=True,required=['bot_id','secret']),
 'signal':channel('Signal',[
  F('account','账号号码','SIGNAL_ACCOUNT','extra.account'),F('http_url','signal-cli 服务地址','SIGNAL_HTTP_URL','extra.http_url'),
  F('allowed_users','私信白名单','SIGNAL_ALLOWED_USERS',kind='list'),F('group_allowed_users','群聊白名单','SIGNAL_GROUP_ALLOWED_USERS',kind='list'),B('require_mention','群聊需要提及机器人','SIGNAL_REQUIRE_MENTION',path='extra.require_mention',default=False),
 ],required=['account','http_url']),
 'yuanbao':channel('腾讯元宝',[
  C('app_id','App ID','YUANBAO_APP_ID','extra.app_id'),C('app_secret','App Secret','YUANBAO_APP_SECRET','extra.app_secret',secret=True),F('bot_id','Bot ID','YUANBAO_BOT_ID','extra.bot_id'),
  policy('dm_policy','私信策略','YUANBAO_DM_POLICY'),policy('group_policy','群聊策略','YUANBAO_GROUP_POLICY'),F('dm_allow_from','私信白名单','YUANBAO_DM_ALLOW_FROM','extra.dm_allow_from',kind='list'),F('group_allow_from','群聊白名单','YUANBAO_GROUP_ALLOW_FROM','extra.group_allow_from',kind='list'),
 ],required=['app_id','app_secret']),
 'bluebubbles':channel('iMessage / BlueBubbles',[
  F('server_url','BlueBubbles 地址','BLUEBUBBLES_SERVER_URL','extra.server_url'),C('password','服务密码','BLUEBUBBLES_PASSWORD','extra.password',secret=True),F('webhook_port','回调端口','BLUEBUBBLES_WEBHOOK_PORT','extra.webhook_port',kind='port',default=8645),F('webhook_host','回调监听地址','BLUEBUBBLES_WEBHOOK_HOST','extra.webhook_host',default='127.0.0.1'),
 ],required=['server_url','password']),
 'google_chat':channel('Google Chat',[
  F('project_id','Google Cloud 项目 ID','GOOGLE_CHAT_PROJECT_ID','extra.project_id'),F('subscription_name','Pub/Sub 订阅名称','GOOGLE_CHAT_SUBSCRIPTION_NAME','extra.subscription_name'),C('service_account','服务账号 JSON 路径或内容','GOOGLE_CHAT_SERVICE_ACCOUNT_JSON','extra.service_account_json',secret=True),
 ],required=['project_id','subscription_name']),
 'sms':channel('短信 / Twilio',[
  C('account_sid','Account SID','TWILIO_ACCOUNT_SID'),C('auth_token','Auth Token','TWILIO_AUTH_TOKEN','api_key',secret=True),F('phone_number','发送号码','TWILIO_PHONE_NUMBER'),
 ],required=['account_sid','auth_token','phone_number']),
 'email':channel('邮件',[
  F('address','邮箱地址','EMAIL_ADDRESS','extra.address'),C('password','密码或授权码','EMAIL_PASSWORD',secret=True),F('imap_host','IMAP 服务器','EMAIL_IMAP_HOST','extra.imap_host'),F('imap_port','IMAP 端口','EMAIL_IMAP_PORT',kind='port',default=993),F('smtp_host','SMTP 服务器','EMAIL_SMTP_HOST','extra.smtp_host'),F('smtp_port','SMTP 端口','EMAIL_SMTP_PORT',kind='port',default=587),F('allowed_users','允许的发件人邮箱','EMAIL_ALLOWED_USERS',kind='list'),
 ],required=['address','password','imap_host','smtp_host']),
 'mattermost':channel('Mattermost',[
  F('url','服务地址','MATTERMOST_URL','extra.url'),C('token','访问 Token','MATTERMOST_TOKEN','token',secret=True),B('require_mention','频道需要提及机器人','MATTERMOST_REQUIRE_MENTION'),
 ],required=['url','token']),
 'teams':channel('Microsoft Teams',[
  C('client_id','Client ID','TEAMS_CLIENT_ID','extra.client_id'),C('client_secret','Client Secret','TEAMS_CLIENT_SECRET','extra.client_secret',secret=True),F('tenant_id','Tenant ID','TEAMS_TENANT_ID','extra.tenant_id'),
 ],required=['client_id','client_secret','tenant_id']),
 'homeassistant':channel('Home Assistant',[
  F('url','服务地址','HASS_URL','extra.url',default='http://homeassistant.local:8123'),C('token','长期访问 Token','HASS_TOKEN','token',secret=True),
 ],required=['token']),
 'webhook':channel('Webhook',[
  C('secret','校验密钥','WEBHOOK_SECRET','extra.secret',secret=True,aliases=['secret']),F('port','监听端口','WEBHOOK_PORT','extra.port',kind='port',default=8649,aliases=['port']),F('host','监听地址',None,'extra.host',default='127.0.0.1',aliases=['host']),
 ],required=['secret']),
}
# These are consumed by native authorization, not PlatformConfig/YAML fields.
# Keep scope to the six channels selected for this rebuild.
AUTH_PREFIXES={'weixin':'WEIXIN','qqbot':'QQ','discord':'DISCORD','feishu':'FEISHU','telegram':'TELEGRAM','wecom':'WECOM'}
for name,prefix in AUTH_PREFIXES.items():
 CATALOG[name]['fields'].append(F('allow_all_users','允许此渠道的所有用户',prefix+'_ALLOW_ALL_USERS',kind='bool',default=False))
ACCESS_FIELDS=[F('global_allow_all','未设置白名单时允许所有用户','GATEWAY_ALLOW_ALL_USERS',kind='bool',default=True)]
# Shared native PlatformConfig members have direct-field precedence and are
# supported by the base adapter. They are intentionally defined only here.
for entry in CATALOG.values():
 entry['fields'].extend([B('typing_indicator','处理消息时显示输入状态',path='typing_indicator'),B('gateway_restart_notification','发送网关重启通知',path='gateway_restart_notification')])

# Adapter precedence differs from core env credential seeding. These settings
# read PlatformConfig.extra first, so a persisted YAML policy wins an env value.
for name,keys in {
 'telegram':['require_mention','free_response_chats','allowed_users'],
 'discord':['require_mention','free_response_channels','allowed_channels','ignored_channels','allowed_users'],
 'slack':['require_mention'], 'matrix':['require_mention'],
 'whatsapp':['dm_policy','group_policy','allowed_users'],
 'feishu':['require_mention'],
 'wecom':['dm_policy','group_policy','allow_from','group_allow_from'],
 'signal':['require_mention'],
}.items():
 for option in CATALOG[name]['fields']:
  if option['key'] not in keys:continue
  option['yaml_first']=True
  path=option['path']
  if path and not path.startswith('extra.'):
   option['aliases'].append(path);option['path']='extra.'+path
