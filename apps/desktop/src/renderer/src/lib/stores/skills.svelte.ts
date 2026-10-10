import type {
	SkillCandidate,
	SkillEntry,
	SkillHistoryEntry,
	SkillsImportOutput,
	SkillsMissingPayload
} from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * P08 right-panel state: the viewed bot's installed skills. Loads on demand
 * when the tab opens; `skills.changed` events refresh the loaded list live
 * (import approval / enable / disable / uninstall / authoring all publish it).
 */
class SkillsState {
	botId = $state<string | null>(null);
	skills = $state<SkillEntry[]>([]);
	loading = $state(false);
	/**
	 * 目录在应用外被删除的技能（core 的 skills.missing 事件），按名字去重的待
	 * 确认队列；MissingSkillDialog 逐个弹出，「知道了」→ purge → 出队。
	 */
	missing = $state<SkillsMissingPayload[]>([]);
	#loadedFor: string | null = null;
	#started = false;

	start(): void {
		if (this.#started) return;
		this.#started = true;
		core.onEvent('skills.missing', (payload) => {
			const data = payload as SkillsMissingPayload;
			console.warn('[skills] skill directory missing', data);
			if (!this.missing.some((item) => item.name === data.name)) {
				this.missing = [...this.missing, data];
			}
		});
		core.onEvent('skills.changed', (payload) => {
			const data = payload as { botId: string };
			// botId 为空串 = 公共技能变更（市场安装/全局启停）：所有已加载面板刷新；
			// 尚无已加载面板时不动（skills.list 要求具体 botId，'' 会被 RPC 校验拒绝）。
			if (data.botId === '') {
				if (this.#loadedFor !== null) void this.load(this.#loadedFor, true);
				return;
			}
			if (data.botId === this.#loadedFor) void this.load(data.botId, true);
		});
	}

	async load(botId: string, force = false): Promise<void> {
		if (!force && this.#loadedFor === botId && this.botId === botId) return;
		this.loading = true;
		try {
			const result = (await core.call('skills.list', { botId })) as { skills: SkillEntry[] };
			this.skills = result.skills;
			this.botId = botId;
			this.#loadedFor = botId;
		} catch (error) {
			// 调用方都是 `void load()`（$effect / skills.changed 事件）：记录到控制台，
			// 不变成未处理的 rejection。
			console.error('[skills] list failed', { botId, error });
		} finally {
			this.loading = false;
		}
	}

	async import(input: {
		botId: string;
		sourceUrl: string;
		ref?: string;
		subdirectory?: string;
	}): Promise<SkillsImportOutput> {
		// A $state Proxy must never cross postMessage: build a plain object.
		const result = (await core.call('skills.import', {
			botId: input.botId,
			sourceUrl: input.sourceUrl,
			...(input.ref !== undefined && input.ref.length > 0 ? { ref: input.ref } : {}),
			...(input.subdirectory !== undefined && input.subdirectory.length > 0
				? { subdirectory: input.subdirectory }
				: {}),
		})) as SkillsImportOutput;
		return result;
	}

	async setEnabled(botId: string, name: string, enabled: boolean): Promise<void> {
		const result = (await core.call(enabled ? 'skills.enable' : 'skills.disable', {
			botId,
			name,
		})) as { skills: SkillEntry[] };
		this.skills = result.skills;
	}

	async uninstall(botId: string, name: string): Promise<void> {
		const result = (await core.call('skills.uninstall', { botId, name })) as {
			skills: SkillEntry[];
		};
		this.skills = result.skills;
	}

	async history(botId: string, name: string): Promise<SkillHistoryEntry[]> {
		const result = (await core.call('skills.history', { botId, name })) as {
			history: SkillHistoryEntry[];
		};
		return result.history;
	}

	async rollback(botId: string, name: string, commitOid: string): Promise<void> {
		const result = (await core.call('skills.rollback', { botId, name, commitOid })) as {
			skills: SkillEntry[];
		};
		this.skills = result.skills;
	}

	async read(
		botId: string,
		name: string,
	): Promise<{ name: string; content: string; dirPath: string }> {
		return (await core.call('skills.read', { botId, name })) as {
			name: string;
			content: string;
			dirPath: string;
		};
	}

	/** 「知道了」：清理该技能的 DB 记录并出队（失败则留在队列里可重试）。 */
	async acknowledgeMissing(name: string): Promise<number> {
		const result = (await core.call('skills.purgeMissing', { name })) as { purged: number };
		this.missing = this.missing.filter((item) => item.name !== name);
		return result.purged;
	}

	/** Re-sent import against a multi-skill repository (candidate pick). */
	candidatesOf(output: SkillsImportOutput): SkillCandidate[] {
		return output.status === 'candidates' ? output.candidates : [];
	}
}

export const skillsStore = new SkillsState();
