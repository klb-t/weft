package dev.klbt.weft;

/** JNI into libweft. The WebView still browses when the library is absent. */
public final class NativePolicy {
    public static final boolean available;

    static {
        boolean loaded = false;
        try {
            System.loadLibrary("weft-jni");
            loaded = true;
        } catch (UnsatisfiedLinkError ignored) {
            loaded = false;
        }
        available = loaded;
    }

    private NativePolicy() {}

    public static native long open(String packJson);

    public static native String command(long handle, String commandJson);

    public static native void close(long handle);
}
