import { fetch } from "@/shared/net"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"

/**
 * 通知を送る。urgent なら ntfy の最優先 (priority 5) で送る (#86: 叩き起こす通知の PoC)。
 * 最優先の通知は、端末側の ntfy アプリの設定で、大きな音・繰り返しにできる。OS のマナー / 集中モードは貫通しない。
 */
export async function sendNtfyNotification(message: string, options: { urgent?: boolean; title?: string } = {}) {
    const topic = StateManager.get().getGlobalSettingsKey("ntfyTopic")
    if (!topic) {
        Logger.log("[NTFY] No topic configured, skipping notification")
        return
    }
    
    try {
        const body = message.substring(0, 140)
        Logger.log(`[NTFY] Sending notification to ${topic}: ${body}`)
        await fetch(`https://ntfy.sh/${topic}`, {
            method: "POST",
            body: body,
            ...(options.urgent || options.title
                ? {
                      headers: {
                          ...(options.urgent ? { Priority: "5", Tags: "rotating_light" } : {}),
                          // HTTP ヘッダは ASCII のみなので、日本語のタイトルは付けない (ASCII のときだけ)
                          ...(options.title && /^[\x20-\x7e]+$/.test(options.title) ? { Title: options.title } : {}),
                      },
                  }
                : {}),
        })
    } catch (e) {
        Logger.error("[NTFY] Failed to send notification", e)
    }
}

/**
 * テスト用のアラームを最優先で送る (#86 PoC の動作確認)。スマホの ntfy アプリで、最優先の通知として鳴るかを確かめる。
 * トピックが未設定なら何も送らず "no-topic" を返す。
 */
export async function sendNtfyTestAlarm(): Promise<"sent" | "no-topic"> {
    if (!StateManager.get().getGlobalSettingsKey("ntfyTopic")) {
        return "no-topic"
    }
    await sendNtfyNotification("[FL-Alarm] INCLINE test alarm: if the INCLINE Alarm page on your phone rang, the whole path works.", {
        urgent: true,
        title: "INCLINE test alarm",
    })
    return "sent"
}
