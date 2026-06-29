import { EasyPrompterConnection } from "./connection.js";
import type { Logger } from "./types.js";

/**
 * Manages socket.io connections to EasyPrompter instances.
 * Singleton per serverUrl+apiKey — multiple actions share the same connection.
 */
export class ConnectionManager {
  private connections = new Map<string, EasyPrompterConnection>();
  private readonly defaultLogger: Logger | undefined;

  constructor(defaultLogger?: Logger) {
    this.defaultLogger = defaultLogger;
  }

  /**
   * Get or create a connection for the given server URL and API key.
   */
  getConnection(serverUrl: string, apiKey: string): EasyPrompterConnection {
    const key = this.buildKey(serverUrl, apiKey);

    let conn = this.connections.get(key);
    if (!conn) {
      conn = new EasyPrompterConnection(
        this.normalizeUrl(serverUrl),
        apiKey,
        this.defaultLogger
      );
      this.connections.set(key, conn);
    }

    return conn;
  }

  /**
   * Disconnect and remove a connection.
   */
  removeConnection(serverUrl: string, apiKey: string): void {
    const key = this.buildKey(serverUrl, apiKey);
    const conn = this.connections.get(key);
    if (conn) {
      conn.disconnect();
      this.connections.delete(key);
    }
  }

  /**
   * Disconnect and remove all connections except the one matching the given URL/key.
   * Used when global settings change to clean up stale connections.
   */
  disconnectAllExcept(serverUrl: string, apiKey: string): void {
    const keepKey = this.buildKey(serverUrl, apiKey);
    for (const [key, conn] of this.connections) {
      if (key !== keepKey) {
        conn.disconnect();
        this.connections.delete(key);
      }
    }
  }

  private normalizeUrl(url: string): string {
    // Strip trailing slash and ensure consistent format
    return url.replace(/\/+$/, "").toLowerCase();
  }

  private buildKey(serverUrl: string, apiKey: string): string {
    return `${this.normalizeUrl(serverUrl)}::${apiKey}`;
  }
}
