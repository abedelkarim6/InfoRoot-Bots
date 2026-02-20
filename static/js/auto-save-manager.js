/**
 * Simple Auto-Save State Manager
 * Automatically saves changes to server and keeps UI in sync
 */

class AutoSaveStateManager {
    constructor() {
        this.storageKey = 'bot_admin_cache';
        this.saveDelay = 1000; // ms to wait before auto-saving
        this.saveTimers = new Map();
    }

    /**
     * Load config with cache fallback
     */
    async loadConfig() {
        try {
            const response = await fetch('/api/config');
            const config = await response.json();
            
            // Cache the config
            this.cacheConfig(config);
            return config;
        } catch (error) {
            console.error('Error loading config from server:', error);
            
            // Fallback to cached config
            const cached = this.getCachedConfig();
            if (cached) {
                console.warn('Using cached config due to server error');
                return cached;
            }
            throw error;
        }
    }

    /**
     * Cache config to localStorage
     */
    cacheConfig(config) {
        localStorage.setItem(this.storageKey, JSON.stringify({
            config,
            timestamp: Date.now()
        }));
    }

    /**
     * Get cached config
     */
    getCachedConfig() {
        const cached = localStorage.getItem(this.storageKey);
        if (!cached) return null;
        
        const { config, timestamp } = JSON.parse(cached);
        
        // Cache expires after 1 hour
        if (Date.now() - timestamp > 3600000) {
            localStorage.removeItem(this.storageKey);
            return null;
        }
        
        return config;
    }

    /**
     * Update and auto-save category
     */
    async updateCategory(group, name, updates, autoSave = true) {
        // Update cache immediately
        const config = this.getCachedConfig() || {};
        config.categories = config.categories || {};
        config.categories[group] = config.categories[group] || {};
        config.categories[group][name] = {
            ...config.categories[group][name],
            ...updates
        };
        this.cacheConfig(config);

        // Auto-save to server with debounce
        if (autoSave) {
            this.debounceSave(`category-${group}-${name}`, async () => {
                await fetch('/api/category/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ group, name, ...updates })
                });
            });
        }

        return config.categories[group][name];
    }

    /**
     * Toggle category with immediate save
     */
    async toggleCategory(group, name, enabled) {
        // Update cache
        const config = this.getCachedConfig() || {};
        if (config.categories?.[group]?.[name]) {
            config.categories[group][name].enabled = enabled;
            this.cacheConfig(config);
        }

        // Save immediately (no debounce for toggles)
        try {
            await fetch('/api/category/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group, name, enabled })
            });
            this.showSaveStatus('Saved', 'success');
        } catch (error) {
            console.error('Error toggling category:', error);
            this.showSaveStatus('Save failed', 'error');
        }
    }

    /**
     * Update schedule with auto-save
     */
    async updateSchedule(group, name, schedule) {
        return this.updateCategory(group, name, { schedule });
    }

    /**
     * Update keywords with auto-save
     */
    async updateKeywords(group, name, keywords) {
        return this.updateCategory(group, name, { keywords });
    }

    /**
     * Update format with auto-save
     */
    async updateFormat(group, name, format) {
        return this.updateCategory(group, name, { format });
    }

    /**
     * Debounced save
     */
    debounceSave(key, saveFn) {
        // Clear existing timer
        if (this.saveTimers.has(key)) {
            clearTimeout(this.saveTimers.get(key));
        }

        // Show saving indicator
        this.showSaveStatus('Saving...', 'pending');

        // Set new timer
        const timer = setTimeout(async () => {
            try {
                await saveFn();
                this.showSaveStatus('Saved', 'success');
                this.saveTimers.delete(key);
            } catch (error) {
                console.error('Error saving:', error);
                this.showSaveStatus('Save failed', 'error');
            }
        }, this.saveDelay);

        this.saveTimers.set(key, timer);
    }

    /**
     * Show save status indicator
     */
    showSaveStatus(message, type) {
        let indicator = document.getElementById('save-status');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'save-status';
            indicator.className = 'save-status';
            document.body.appendChild(indicator);
        }

        indicator.textContent = message;
        indicator.className = `save-status ${type}`;
        indicator.style.display = 'block';

        // Auto-hide success messages
        if (type === 'success') {
            setTimeout(() => {
                indicator.style.display = 'none';
            }, 2000);
        }
    }

    /**
     * Update bot settings with auto-save
     */
    async updateBot(botName, updates) {
        // Update cache immediately
        const config = this.getCachedConfig() || {};
        config.bots = config.bots || {};
        config.bots[botName] = {
            ...config.bots[botName],
            ...updates
        };
        this.cacheConfig(config);

        // Auto-save to server with debounce
        this.debounceSave(`bot-${botName}`, async () => {
            const fullBot = config.bots[botName];
            await fetch('/api/bot/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: botName, ...fullBot })
            });
        });

        return config.bots[botName];
    }

    /**
     * Update category with auto-save
     */
    async updateCategory(group, name, updates) {
        const config = this.getCachedConfig() || {};
        config.categories = config.categories || {};
        config.categories[group] = config.categories[group] || {};
        config.categories[group][name] = {
            ...config.categories[group][name],
            ...updates
        };
        this.cacheConfig(config);

        // Auto-save to server with debounce
        this.debounceSave(`category-${group}-${name}`, async () => {
            await fetch('/api/category/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group, name, ...updates })
            });
        });

        return config.categories[group][name];
    }

    /**
     * Clear all caches
     */
    clearCache() {
        localStorage.removeItem(this.storageKey);
    }
}

// Global instance
const autoSave = new AutoSaveStateManager();

// Usage example:
/*
// Load config on page load
const config = await autoSave.loadConfig();

// Toggle category (saves immediately)
await autoSave.toggleCategory('countries', 'USA', true);

// Update keywords (auto-saves after 1 second)
await autoSave.updateKeywords('countries', 'USA', ['keyword1', 'keyword2']);

// Update schedule (auto-saves after 1 second)
await autoSave.updateSchedule('countries', 'USA', { type: 'hourly', minute: 30 });
*/
