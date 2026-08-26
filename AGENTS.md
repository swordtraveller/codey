# AGENTS

## git

### git commit message 格式

使用如下格式：  
```
feat(scope): xxx (#issue)

details
```
其中scope, xxx, details按实际情况填写。  
#issue按照用户每次指示的填写，用户没有指示时要主动询问用户。  

## 产品设计

### 上下文管理策略

**核心原则：保真优先，压缩为主，截断仅兜底**  

#### 配置参数
- `model_max_ctx`：模型最大上下文
- `safe_output_margin`：输出预留token缓冲
- `trigger_threshold = model_max_ctx - safe_output_margin`：压缩触发线

#### 执行规则
1. 本地统计全部输入token；输入token ≥ `trigger_threshold` 才触发压缩。
2. 先执行Filter抽取：原样保留代码块、工具IO、报错堆栈；仅删除无关冗余片段，不改写原文。
3. Filter后token达标，则直接跳过Rewrite。
4. Filter仍超限，仅对**纯自然语言片段**做Rewrite；代码/报错/日志严禁送入Rewrite，禁止编造事实。
5. 压缩完成重新统计token。
6. 压缩后依旧超限：执行兜底截断，删除最早的完整历史消息；system与最近N轮不删除。

#### 补充
1. 不使用在线模型API自动truncation特性，而应当全部本地管控。
2. 输出压缩指标：原始token、压缩后token、压缩比，输出到压缩函数返回结构体的附加字段，然后让产品的会话状态栏里能展示：上下文总窗口使用百分比（`model_max_ctx` 为上限）、上下文输入预留窗口使用百分比（`trigger_threshold` 为上限）、压缩比信息（`压缩前 token 数 / 压缩后 token 数 * 1.0`）。
