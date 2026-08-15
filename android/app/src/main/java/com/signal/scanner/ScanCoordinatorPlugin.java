package com.signal.scanner;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Exposes the same native scan lease to the Capacitor WebView. */
@CapacitorPlugin(name = "ScanCoordinator")
public class ScanCoordinatorPlugin extends Plugin {
    @PluginMethod
    public void acquire(PluginCall call) {
        boolean acquired = ScanLease.tryAcquire(getContext());
        JSObject result = new JSObject();
        result.put("acquired", acquired);
        result.put("expiresAt", ScanLease.expiresAt(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void release(PluginCall call) {
        ScanLease.release(getContext());
        call.resolve();
    }
}
