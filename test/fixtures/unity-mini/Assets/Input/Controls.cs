using UnityEngine.InputSystem;
namespace Game
{
    public partial class @Controls
    {
        public GameplayActions @Gameplay => new GameplayActions(this);
        public struct GameplayActions
        {
            private @Controls m_Wrapper;
            public GameplayActions(@Controls wrapper) { m_Wrapper = wrapper; }
            public InputAction @Fire => null;
            public void SetCallbacks(IGameplayActions instance) { }
        }
        public interface IGameplayActions
        {
            void OnFire(InputAction.CallbackContext context);
        }
    }
}
