Shader "Custom/Glow"
{
    Properties
    {
        _Glow ("Glow", Float) = 1
    }
    SubShader
    {
        Pass
        {
            HLSLPROGRAM
            #include "Common.hlsl"
            ENDHLSL
        }
    }
}
