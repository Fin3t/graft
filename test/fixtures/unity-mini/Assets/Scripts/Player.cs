using UnityEngine;
using UnityEngine.InputSystem;
namespace Game
{
    public class Player : MonoBehaviour, Controls.IGameplayActions
    {
        Controls controls;
        void Awake() { controls = new Controls(); controls.Gameplay.SetCallbacks(this); }
        public void OnFire(InputAction.CallbackContext context) { }
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void Boot() { }
        [ContextMenu("Lay Out")]
        void LayOut() { }
    }
}
