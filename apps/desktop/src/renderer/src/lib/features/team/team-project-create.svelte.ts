import type { TeamBotView } from '@kepcup/shared';
import { projectTitleFromMemberNames } from '@kepcup/shared';
import { connections, type SourceId } from '$lib/rpc/connections.svelte';
import { chat } from '$lib/stores/chat.svelte';
import { teamBots } from './team-bots.svelte';

/**
 * 团队项目组创建流（member-bots B4 子域 A）：lead（服务端可见 Bot 单选）→
 * 成员多选（Bot 多选 + 人类成员多选）→ `projects.create`（经该来源连接，
 * 服务端 keepCallerAsOnlyPrincipal 强制 caller 为唯一人类主体）→
 * `team.projects.addMembers` 补其他人类成员 → 跳转新会话。交互参照本机
 * project-compose（两轮选择压缩进一个对话框）与 ProjectMembersEditor 的行样式。
 *
 * 宿主接线（子域 B）：`openTeamProjectCreate(source)` 打开（挂
 * TeamProjectCreateDialog.svelte），`closeTeamProjectCreate()` 关闭；状态本体在
 * 这里，测试直击本模块。
 */

export interface TeamProjectMemberLite {
  id: string;
  displayName: string;
}

export class TeamProjectCreateState {
  readonly source: SourceId;
  loading = $state(true);
  loadError = $state<string | null>(null);
  /** 服务端可见 Bot（team.bots.list；lead / Bot 成员的候选）。 */
  bots = $state<TeamBotView[]>([]);
  /** 人类成员候选（team.members.list，不含自己）。 */
  humans = $state<TeamProjectMemberLite[]>([]);
  leadBotId = $state<string | null>(null);
  /** Bot 成员（不含 lead；提交时并入 memberBotIds）。 */
  memberBotIds = $state<string[]>([]);
  /** 人类成员（projects.create 只带 caller，其余经 team.projects.addMembers）。 */
  humanMemberIds = $state<string[]>([]);
  submitting = $state(false);
  errorCode = $state<string | null>(null);

  constructor(source: SourceId) {
    this.source = source;
  }

  async init(): Promise<void> {
    try {
      const [bots, members] = await Promise.all([
        teamBots.loadTeamBots(this.source).then(() => teamBots.teamBotsOf(this.source)),
        teamBots.listMembers(this.source),
      ]);
      this.bots = bots.bots;
      const selfId = teamBots.selfMemberIdOf(this.source);
      this.humans = members
        .filter((member) => member.id !== selfId)
        .map((member) => ({ id: member.id, displayName: member.displayName }));
      this.loadError = null;
    } catch (error) {
      this.loadError = errorCodeOf(error);
    } finally {
      this.loading = false;
    }
  }

  get lead(): TeamBotView | null {
    return this.bots.find((bot) => bot.id === this.leadBotId) ?? null;
  }

  /** 候选 Bot 成员（lead 不重复出现在成员轮）。 */
  get botCandidates(): TeamBotView[] {
    return this.bots.filter((bot) => bot.id !== this.leadBotId);
  }

  /** 标题预览（与本机 compose 同源派生：lead 在前，成员名连接）。 */
  get titlePreview(): string {
    const lead = this.lead;
    if (lead === null) return '';
    const members = this.memberBotIds
      .map((id) => this.bots.find((bot) => bot.id === id))
      .filter((bot) => bot !== undefined)
      .map((bot) => bot!.name);
    return projectTitleFromMemberNames([lead.name, ...members]);
  }

  get canSubmit(): boolean {
    return this.leadBotId !== null && this.memberBotIds.length >= 1;
  }

  get submitDisabled(): boolean {
    return this.loading || !this.canSubmit || this.submitting;
  }

  selectLead(botId: string): void {
    if (this.leadBotId === botId) return;
    this.leadBotId = botId;
    // 换 lead 后旧 lead 回到成员候选；原成员轮里的选择保留（本机 compose 同语义）。
    this.memberBotIds = this.memberBotIds.filter((id) => id !== botId);
  }

  toggleBotMember(botId: string): void {
    this.memberBotIds = this.memberBotIds.includes(botId)
      ? this.memberBotIds.filter((id) => id !== botId)
      : [...this.memberBotIds, botId];
  }

  toggleHuman(memberId: string): void {
    this.humanMemberIds = this.humanMemberIds.includes(memberId)
      ? this.humanMemberIds.filter((id) => id !== memberId)
      : [...this.humanMemberIds, memberId];
  }

  /** 创建 + 加人 + 跳转；成功返回 true（宿主随后收起对话框）。 */
  async submit(): Promise<boolean> {
    if (this.submitDisabled) return false;
    const lead = this.lead;
    if (lead === null) return false;
    const members = this.memberBotIds
      .map((id) => this.bots.find((bot) => bot.id === id))
      .filter((bot): bot is TeamBotView => bot !== undefined);
    if (members.length < 1) return false;
    this.submitting = true;
    this.errorCode = null;
    try {
      const conn = connections.get(this.source);
      const result = (await conn.call('projects.create', {
        title: this.titlePreview,
        leadBotId: lead.id,
        memberBotIds: [lead.id, ...members.map((bot) => bot.id)],
      })) as { conversation: { id: string } };
      if (this.humanMemberIds.length > 0) {
        await conn.callTeam('team.projects.addMembers', {
          conversationId: result.conversation.id,
          memberIds: this.humanMemberIds,
        });
      }
      await chat.select({ source: this.source, id: result.conversation.id });
      return true;
    } catch (error) {
      this.errorCode = errorCodeOf(error);
      return false;
    } finally {
      this.submitting = false;
    }
  }
}

class TeamProjectCreateHost {
  /** 打开中的创建流（null = 未打开）。 */
  state = $state<TeamProjectCreateState | null>(null);

  open(source: SourceId): void {
    const state = new TeamProjectCreateState(source);
    this.state = state;
    void state.init();
  }

  close(): void {
    this.state = null;
  }
}

export const teamProjectCreate = new TeamProjectCreateHost();

/** 子域 B 的启动入口（+ 面板「新建团队项目组」）。 */
export function openTeamProjectCreate(source: SourceId): void {
  teamProjectCreate.open(source);
}

export function closeTeamProjectCreate(): void {
  teamProjectCreate.close();
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : 'INTERNAL';
}
