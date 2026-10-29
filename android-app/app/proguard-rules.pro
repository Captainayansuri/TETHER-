# OkHttp and CameraX ship consumer rules for their reflective/library internals.
# Keep source line information for crash reports and R8 retracing.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Strip all Android platform logging from release bytecode.
-assumenosideeffects class android.util.Log {
    public static *** v(...);
    public static *** d(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
    public static *** wtf(...);
}
