/**
 * 对话内应用设置的常驻提示词规则（todo/conversational-app-setup.md §5.1：只此一条，工具注入时
 * 才出现）。不在提示词里列设置项——设置清单靠 settings_search / settings_read 逐层披露。
 */
export const SETTINGS_RULE =
  '用户的需求要调整 KepCup 的设置（模型、联网、连接、邮箱、外部智能体、你自己的配置等）才能实现，或你不确定应用当前能不能做时：先用 settings_search 查，再用 settings_read 看清楚，最后用 settings_change 修改或请用户在卡片里完成；不要让用户自己去设置页找，也不要让用户把密钥、密码贴进聊天。';

/**
 * ACP 外部智能体默认只注入 settings_search / settings_read（§5.3 第 7 条）：能查不能改，要改的
 * 写进任务结果交回对话中的你。
 */
export const SETTINGS_READ_ONLY_RULE =
  '用户的需求要调整 KepCup 的设置（模型、联网、连接、邮箱、外部智能体、你自己的配置等）才能实现，或你不确定应用当前能不能做时：先用 settings_search 查，再用 settings_read 看清楚；你在这里不能修改设置，需要改的在结果里写明是哪一项（id）与原因，由对话中的你去处理；不要让用户把密钥、密码贴进聊天。';
