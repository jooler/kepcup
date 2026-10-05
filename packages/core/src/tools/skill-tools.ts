import { Type } from '@earendil-works/pi-ai';
import { AppError } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';
import type { PreparedImport } from '../skills/library.js';

/**
 * install_skill（docs/design/22-file-skill-routing.md，D63）：模型请求安装
 * 技能的两条路径——
 * - preset_id：应用内置推荐技能（可信内容），阻塞审批 `skill_preset` 后装为
 *   公共技能（全体 Bot 可用）；
 * - source_url：任意外部 git 技能仓库，先 clone+静态扫描（prepare），阻塞
 *   审批 `skill_import`（卡片带扫描结果）后按 Bot 私有安装（commit）。
 *
 * 拒绝/取消返回 APPROVAL_DENIED 结果文本，run 继续执行（模型降级或如实答复）；
 * 审批等待期间 run 置 waiting_approval，run 取消联动取消审批。
 */

export interface SkillInstallFacade {
  /** 预置描述（payload 组装）；未知 presetId 抛 NOT_FOUND。 */
  describePreset(presetId: string): {
    presetId: string;
    name: string;
    displayName: string;
    summary: string;
    version: string;
    missingDeps: string[];
    installed: boolean;
  };
  /** 安装预置为公共技能（幂等）；返回技能 SKILL.md 路径。 */
  installPreset(presetId: string): { skillPath: string | null };
  /** 外部仓库 prepare（clone + 扫描，携带目标 Bot 身份）；多技能仓库带 subdirectory 重试。 */
  prepareFromUrl(input: {
    sourceUrl: string;
    ref?: string;
    subdirectory?: string;
    botId: string;
    conversationId: string;
  }): Promise<PreparedImport>;
  /** 批准后落位（按 Bot 安装）；失败由调用方标记审批 failed。 */
  commitImport(prepared: PreparedImport): void;
  /** prepare 产物的清理（拒绝/取消时丢弃 staging）。 */
  discardImport(prepared: PreparedImport): void;
  /** 阻塞审批（等待用户决定；run 置 waiting_approval，取消联动）。 */
  requestApproval(
    identity: RunIdentity,
    kind: 'skill_preset' | 'skill_import',
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ decision: 'approved' | 'denied' | 'cancelled'; approvalId: string }>;
  /** 审批已批准但落位失败：把卡片改为 failed 终态（BR-P08-004）。 */
  failApproval(approvalId: string, reason: string): void;
}

export function buildSkillTools(input: {
  identity: RunIdentity;
  skills: SkillInstallFacade;
}): ToolDefinition[] {
  const { identity, skills } = input;

  const installSkill: ToolDefinition<{
    preset_id?: string;
    source_url?: string;
    ref?: string;
    subdirectory?: string;
    reason: string;
  }> = {
    name: 'install_skill',
    description:
      '请求用户授权安装一个技能。两类来源：preset_id=应用内置推荐技能（见系统提示 <recommended_skills> 列表）；source_url=外部 git 仓库（先用 web_search 检索技能仓库）。会弹出审批卡，用户批准后技能立即安装可用；拒绝时你会收到拒绝结果，请降级处理或如实告知用户。reason 简述为什么要装（展示给用户）。',
    parameters: Type.Object({
      preset_id: Type.Optional(
        Type.String({ description: '内置推荐技能的 preset_id（与 source_url 二选一）' }),
      ),
      source_url: Type.Optional(
        Type.String({ description: '外部技能仓库的 HTTPS git 地址（与 preset_id 二选一）' }),
      ),
      ref: Type.Optional(Type.String({ description: '分支或标签（外部仓库可选）' })),
      subdirectory: Type.Optional(
        Type.String({ description: '仓库内的技能子目录（多技能仓库时指定）' }),
      ),
      reason: Type.String({ description: '安装原因，会展示给用户' }),
    }),
    execute: async (params, ctx) => {
      if (identity.botId === null || identity.conversationId === null) {
        return {
          ok: false,
          content: '当前执行没有对话上下文，无法请求安装技能',
          errorCode: 'INVALID_INPUT',
        };
      }
      if ((params.preset_id === undefined) === (params.source_url === undefined)) {
        return {
          ok: false,
          content: 'preset_id 与 source_url 必须二选一',
          errorCode: 'INVALID_INPUT',
        };
      }

      // --- 预置路径：轻授权 → 装公共技能 ------------------------------------
      if (params.preset_id !== undefined) {
        let payload;
        try {
          payload = skills.describePreset(params.preset_id);
        } catch (error) {
          if (error instanceof AppError && error.code === 'NOT_FOUND') {
            return {
              ok: false,
              content: `预置技能 ${params.preset_id} 不存在（以系统提示 <recommended_skills> 列表为准）`,
              errorCode: 'NOT_FOUND',
            };
          }
          throw error;
        }
        if (payload.installed) {
          const path = skills.installPreset(payload.presetId).skillPath;
          return {
            ok: true,
            content: `技能 ${payload.name} 已经安装，无需重复安装${path !== null ? `，SKILL.md：${path}` : ''}。用 read 读取即可使用。`,
          };
        }
        const outcome = await skills.requestApproval(
          identity,
          'skill_preset',
          { ...payload } as Record<string, unknown>,
          ctx.signal,
        );
        if (outcome.decision !== 'approved') {
          return approvalDeniedResult(outcome.decision);
        }
        try {
          const { skillPath } = skills.installPreset(payload.presetId);
          return {
            ok: true,
            content: `用户已批准，技能 ${payload.name} 安装完成并已启用${skillPath !== null ? `，SKILL.md：${skillPath}` : ''}。用 read 读取 SKILL.md 按其指引处理当前文件/任务。`,
          };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          skills.failApproval(outcome.approvalId, `技能安装失败：${reason}`);
          return {
            ok: false,
            content: `技能安装失败：${reason}`,
            errorCode: 'INTERNAL',
          };
        }
      }

      // --- 外部仓库路径：clone + 扫描 → 完整审批 → 按 Bot 安装 ---------------
      const sourceUrl = params.source_url as string;
      let prepared;
      try {
        prepared = await skills.prepareFromUrl({
          sourceUrl,
          ...(params.ref !== undefined ? { ref: params.ref } : {}),
          ...(params.subdirectory !== undefined ? { subdirectory: params.subdirectory } : {}),
          botId: identity.botId,
          conversationId: identity.conversationId,
        });
      } catch (error) {
        if (error instanceof AppError) {
          return { ok: false, content: error.message, errorCode: error.code };
        }
        return {
          ok: false,
          content: `技能仓库克隆或扫描失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'SKILL_IMPORT_FAILED',
        };
      }
      const compatNote =
        prepared.scan.compatibility === 'compatible'
          ? '兼容'
          : prepared.scan.compatibility === 'partial'
            ? '部分兼容'
            : '不兼容';
      try {
        const outcome = await skills.requestApproval(
          identity,
          'skill_import',
          prepared.payload as Record<string, unknown>,
          ctx.signal,
        );
        if (outcome.decision !== 'approved') {
          skills.discardImport(prepared);
          return approvalDeniedResult(outcome.decision);
        }
        try {
          skills.commitImport(prepared);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          skills.failApproval(outcome.approvalId, `技能导入落位失败：${reason}`);
          return {
            ok: false,
            content: `技能导入失败：${reason}`,
            errorCode: 'INTERNAL',
          };
        }
        return {
          ok: true,
          content: `用户已批准，技能 ${prepared.scan.name} 导入完成并已对本 Bot 启用（兼容性：${compatNote}）。用 read 读取其 SKILL.md 按其指引处理当前文件/任务。`,
        };
      } catch (error) {
        skills.discardImport(prepared);
        throw error;
      }
    },
  };

  return [installSkill];
}

function approvalDeniedResult(decision: 'denied' | 'cancelled'): ToolResult {
  const reason =
    decision === 'denied'
      ? '用户拒绝或取消了该安装请求。不要重复请求：降级用其他方式处理（或如实告知用户当前无法处理该文件/任务）。'
      : '该安装请求因执行结束被取消。';
  return { ok: false, content: reason, errorCode: 'APPROVAL_DENIED' };
}
