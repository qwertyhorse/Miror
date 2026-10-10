@file:OptIn(kotlinx.coroutines.InternalCoroutinesApi::class)

package ai.openbuy.exhibition

import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.MainCoroutineDispatcher
import kotlinx.coroutines.internal.MainDispatcherFactory
import kotlin.coroutines.CoroutineContext

/** Supplies Dispatchers.Main for the isolated JVM classpath only. */
class FixtureMainDispatcherFactory : MainDispatcherFactory {
    override val loadPriority: Int = 1_000
    override fun createDispatcher(allFactories: List<MainDispatcherFactory>): MainCoroutineDispatcher = FixtureMainDispatcher
    override fun hintOnError(): String = "The native flow fixture dispatcher was not installed."
}

object FixtureMainDispatcher : MainCoroutineDispatcher() {
    private val thread = AtomicReference<Thread>()
    private val executor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "fixture-main").apply { isDaemon = true; thread.set(this) }
    }
    override val immediate: MainCoroutineDispatcher get() = this
    override fun isDispatchNeeded(context: CoroutineContext): Boolean = Thread.currentThread() !== thread.get()
    override fun dispatch(context: CoroutineContext, block: Runnable) { executor.execute(block) }
    fun close() { executor.shutdownNow() }
}
