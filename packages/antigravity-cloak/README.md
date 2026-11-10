# @magpie-community/middleware-antigravity-cloak

Claude Code and Claude Desktop on an Antigravity account, as [magpie](https://usemagpie.ai) gateway middleware.

Antigravity answers a request whose system prompt reads as Claude Code's or the Claude Agent SDK's (which Claude Desktop's chats use) with `429 Resource has been exhausted`, however much quota is left. magpie shows it as a 400 that says so. Tried with a real account, Antigravity matches two pieces of the prompt:

- Claude Code's billing line, `x-anthropic-billing-header: …`;
- `You are a Claude agent, built on Anthropic's Claude Agent SDK`.

The same prompt goes through when each has a zero-width space (U+200B) inside it. This middleware puts one after the first letter of `x-anthropic-billing-header` and `Claude Agent SDK`, in the system prompt only, and only in what an Antigravity account is sent. Every other provider, a Claude subscription above all, gets the prompt as the agent wrote it, even in a routing group that tries Antigravity first. The model reads the words as before.

It needs a magpie with the `onProvider` hook (v0.1.1283 or later): an older magpie loads it and never calls it, so requests go as they came.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-antigravity-cloak`.

## Before you turn it on

- This changes what Google is sent so that a request it means to refuse isn't refused. It may be against Antigravity's terms, and Google can ban the account for it. Use it on an account you can afford to lose.
- Google can change what it matches at any time. Then the refusal comes back, and magpie may no longer recognise it as this refusal: it can read as a real quota running out and rest the account. If that happens, add the new words to `extraWords`, or turn the plugin off.

## Options

```json
{ "extraWords": [], "accounts": ["antigravity"], "off": false }
```

- `extraWords`: more words to break the same way, matched whatever their case.
- `accounts`: the subscriptions it acts on, by kind. `antigravity` is the default.
- `off`: leave every request as it came.

中文：Antigravity 看到 Claude Code / Claude Agent SDK 的系统提示词会回一个假的 429。这个中间件只在发给 Antigravity 账号的请求里，往 `x-anthropic-billing-header` 和 `Claude Agent SDK` 里插一个零宽空格，其他供应商（尤其是 Claude 订阅）收到的提示词不变。这样做可能违反 Antigravity 的条款，账号有被封的风险，请只用在可以承受损失的账号上。需要 magpie v0.1.1283 或更新版本。

After [hexiaolv/magpie-antigravity-cloak](https://github.com/hexiaolv/magpie-antigravity-cloak) (MIT), which breaks a longer list of words in every request, whatever provider it goes to.
