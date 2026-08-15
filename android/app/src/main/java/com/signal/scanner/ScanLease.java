package com.signal.scanner;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Serializes foreground WebView scans and WorkManager scans. The expiry makes
 * a crashed process recoverable without leaving scanning disabled indefinitely.
 */
final class ScanLease {
    private static final String PREFERENCES = "RSignalsScanLease";
    private static final String EXPIRES_AT = "expiresAt";
    private static final long LEASE_MS = 2L * 60L * 1000L;

    private ScanLease() {}

    static synchronized boolean tryAcquire(Context context) {
        SharedPreferences preferences = preferences(context);
        long now = System.currentTimeMillis();
        if (preferences.getLong(EXPIRES_AT, 0L) > now) return false;
        return preferences.edit().putLong(EXPIRES_AT, now + LEASE_MS).commit();
    }

    static synchronized void renew(Context context) {
        preferences(context).edit().putLong(EXPIRES_AT, System.currentTimeMillis() + LEASE_MS).commit();
    }

    static synchronized void release(Context context) {
        preferences(context).edit().remove(EXPIRES_AT).commit();
    }

    static synchronized long expiresAt(Context context) {
        return preferences(context).getLong(EXPIRES_AT, 0L);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
