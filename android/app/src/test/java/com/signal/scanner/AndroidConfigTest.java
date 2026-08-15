package com.signal.scanner;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class AndroidConfigTest {
    @Test
    public void keepsTheStableApplicationId() {
        assertEquals("com.signal.scanner", MainActivity.class.getPackage().getName());
    }
}
