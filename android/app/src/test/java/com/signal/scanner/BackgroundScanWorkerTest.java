package com.signal.scanner;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BackgroundScanWorkerTest {
    @Test
    public void notificationFollowerThresholdOnlyAppliesToXAndLinkedIn() throws Exception {
        assertTrue(BackgroundScanWorker.passesNotificationFollowerThreshold("reddit", 0, 500));
        assertFalse(BackgroundScanWorker.passesNotificationFollowerThreshold("x", 0, 500));
        assertTrue(BackgroundScanWorker.passesNotificationFollowerThreshold("linkedin", 1000, 500));
    }

    @Test
    public void urlFallbackIdentityMatchesTheForegroundCanonicalForm() throws Exception {
        assertEquals("substack:url:https://example.invalid/post", BackgroundScanWorker.postKey(
            "substack", "content-fallback", "http://www.example.invalid/post/?ignored=1"
        ));
    }

    @Test
    public void linkedInActivityDashUrlUsesTheSharedStableIdentity() {
        assertEquals("linkedin:726987654321", BackgroundScanWorker.postKey(
            "linkedin", "content-fallback", "https://www.linkedin.com/feed/update/activity-726987654321/"
        ));
    }

    @Test
    public void onlyRateLimitsAndServerFailuresAreRetried() {
        assertTrue(BackgroundScanWorker.isRetryableProviderStatus(429));
        assertTrue(BackgroundScanWorker.isRetryableProviderStatus(500));
        assertFalse(BackgroundScanWorker.isRetryableProviderStatus(400));
        assertFalse(BackgroundScanWorker.isRetryableProviderStatus(401));
    }
}
